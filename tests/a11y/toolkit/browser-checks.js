/* eslint-disable no-var */
/**
 * In-page accessibility checks that go beyond what axe-core reports.
 *
 * This file is injected into the page under test (after axe-core, whose
 * accessible-name and role computation it reuses) and exposes
 * `window.__a11yToolkit`. It knows nothing about any one application: every
 * rule works from the rendered DOM, computed styles, and the accessibility
 * name/role axe derives, so it can be pointed at any page in any state.
 *
 * Each finding is `{ rule, tier, wcag, selector, name, html, message, data }`.
 * `tier` says how much to trust it without a human:
 *   - "fail"   : mechanically certain. The rule cannot fire on conformant markup.
 *   - "review" : a heuristic. It finds what a manual tester would look at, but a
 *                person (or a model) still has to decide whether it is a defect.
 *   - "house"  : conformant to WCAG, but not the way our accessibility skill
 *                (accessibility.md) says to build it. Reported so new code
 *                follows the house pattern; does not fail a build on its own.
 */
(function () {
    'use strict';

    var INTERACTIVE = [
        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
        '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="switch"]', '[role="tab"]',
        '[role="menuitem"]', '[role="radio"]', '[role="combobox"]', '[role="textbox"]', '[role="slider"]',
        '[tabindex]:not([tabindex="-1"])', '[contenteditable=""]', '[contenteditable="true"]'
    ].join(',');

    var TEXT_FIELD_TYPES = ['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', ''];

    // Characters that are pictures rather than words: arrows, geometric shapes,
    // dingbats, maths operators used as icons, emoji. Ordinary punctuation that
    // screen readers skip or read sensibly (. , : ; ? ! ' " ( ) - / & % * #) is
    // deliberately not in here.
    var SYMBOL = /[×÷←-⇿∀-⋿⌀-⏿■-◿☀-➿⤀-⥿⬀-⯿〰\u{1f000}-\u{1faff}]|^[+−–—<>=|~^]+$/u;
    var HAS_WORD = /[\p{L}\p{N}]/u;

    function styleOf(el) { return window.getComputedStyle(el); }

    function isRendered(el) {
        if (!el || !el.isConnected) return false;
        if (el.closest('[hidden], [inert]')) return false;
        // While a modal <dialog> is open the browser makes everything outside
        // it inert, without any attribute to show for it.
        var modal = document.querySelector('dialog:modal');
        if (modal && !modal.contains(el)) return false;
        // Content of a closed <details> (and anything else under
        // content-visibility: hidden) keeps a layout box but is not shown.
        if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false;
        for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
            var style = styleOf(node);
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        }
        // A closed <dialog> or a collapsed panel can keep display but have no box.
        return el.getClientRects().length > 0;
    }

    function isExposed(el) {
        return isRendered(el) && !el.closest('[aria-hidden="true"]');
    }

    /** True for the "visually hidden" pattern (1px clip), which is not shown on screen. */
    function isVisuallyHidden(el) {
        for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
            var style = styleOf(node);
            var rect = node.getBoundingClientRect();
            if ((rect.width <= 1 || rect.height <= 1) && style.overflow !== 'visible') return true;
            if (style.clipPath && style.clipPath !== 'none' && /inset\(\s*(50|100)%/.test(style.clipPath)) return true;
            if (parseFloat(style.opacity) === 0) return true;
        }
        return false;
    }

    function selectorFor(el) {
        if (!el || el.nodeType !== 1) return '';
        if (el.id) return '#' + CSS.escape(el.id);
        var parts = [];
        for (var node = el; node && node.nodeType === 1 && parts.length < 4; node = node.parentElement) {
            if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
            var part = node.tagName.toLowerCase();
            var cls = Array.prototype.slice.call(node.classList, 0, 2);
            if (cls.length) part += '.' + cls.map(function (c) { return CSS.escape(c); }).join('.');
            var parent = node.parentElement;
            if (parent) {
                var same = Array.prototype.filter.call(parent.children, function (c) {
                    return c.tagName === node.tagName && c.className === node.className;
                });
                if (same.length > 1) part += ':nth-of-type(' + (Array.prototype.filter.call(parent.children, function (c) {
                    return c.tagName === node.tagName;
                }).indexOf(node) + 1) + ')';
            }
            parts.unshift(part);
            if (node.tagName === 'BODY') break;
        }
        return parts.join(' > ');
    }

    function snippet(el) {
        var html = el.outerHTML.replace(/\s+/g, ' ');
        return html.length > 220 ? html.slice(0, 220) + '…' : html;
    }

    // ------------------------------------------------------------ name and role

    var axeReady = false;
    function withAxe(fn) {
        if (!window.axe) throw new Error('a11y toolkit: axe-core must be injected first');
        if (axeReady) return fn();
        window.axe.setup(document.documentElement);
        axeReady = true;
        try { return fn(); } finally { window.axe.teardown(); axeReady = false; }
    }

    function vnode(el) { return window.axe.utils.getNodeFromTree(el); }

    function nameOf(el) {
        try {
            var v = vnode(el);
            return v ? window.axe.commons.text.accessibleTextVirtual(v).replace(/\s+/g, ' ').trim() : '';
        } catch (_) { return ''; }
    }

    function roleOf(el) {
        try {
            var v = vnode(el);
            return (v && window.axe.commons.aria.getRole(v)) || '';
        } catch (_) { return ''; }
    }

    function controls(root) {
        return Array.prototype.filter.call(root.querySelectorAll(INTERACTIVE), function (el) {
            if (!isExposed(el)) return false;
            if (el.matches('input[type="file"]') && isVisuallyHidden(el)) return false;
            return true;
        });
    }

    function finding(rule, tier, wcag, el, message, data) {
        return {
            rule: rule, tier: tier, wcag: wcag,
            selector: selectorFor(el),
            name: el.matches && el.matches(INTERACTIVE) ? nameOf(el) : '',
            html: snippet(el),
            message: message,
            data: data || {}
        };
    }

    // ------------------------------------------------------------------- rules

    /** Controls whose name is empty or is only a glyph ("+", "×", "▼"). */
    function ruleControlNames(root, out) {
        controls(root).forEach(function (el) {
            var role = roleOf(el);
            var name = nameOf(el);
            if (!name) {
                out.push(finding('control-name-missing', 'fail', '4.1.2', el,
                    'Control has no accessible name.', { role: role }));
            } else if (!HAS_WORD.test(name)) {
                out.push(finding('control-name-symbol-only', 'fail', '2.4.6 / 4.1.2', el,
                    'Accessible name "' + name + '" is only a symbol, so it does not say what the control does.',
                    { role: role }));
            } else if (SYMBOL.test(name)) {
                out.push(finding('control-name-has-symbol', 'fail', '1.1.1 / 2.4.6', el,
                    'Accessible name "' + name + '" includes a decorative glyph that will be read aloud.',
                    { role: role }));
            }
        });
    }

    /**
     * Two or more controls that a screen-reader user hears as identical but that
     * do different things. Links to the same URL are the same control twice and
     * are left alone.
     */
    function ruleDuplicateNames(root, out) {
        var groups = new Map();
        controls(root).forEach(function (el) {
            var name = nameOf(el);
            if (!name) return;
            var role = roleOf(el) || el.tagName.toLowerCase();
            // Options of one radio group legitimately share nothing; skip grouped radios.
            if (role === 'radio' || role === 'option') return;
            var key = role + '|' + name.toLowerCase();
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(el);
        });
        groups.forEach(function (els, key) {
            if (els.length < 2) return;
            var hrefs = new Set(els.map(function (el) { return el.getAttribute('href') || ''; }));
            if (els[0].matches('a[href]') && hrefs.size === 1) return;
            els.forEach(function (el) {
                out.push(finding('control-name-duplicate', 'fail', '2.4.6 / 2.4.4', el,
                    els.length + ' controls share the role and name "' + key.split('|')[1] +
                    '", so they cannot be told apart by name alone.',
                    { role: key.split('|')[0], count: els.length }));
            });
        });
    }

    /** An interactive element that contains another one. */
    function ruleNestedInteractive(root, out) {
        controls(root).forEach(function (el) {
            if (el.tagName === 'LABEL') return;
            var inner = Array.prototype.filter.call(el.querySelectorAll(INTERACTIVE), isExposed);
            if (!inner.length) return;
            out.push(finding('nested-interactive', 'fail', '4.1.2', el,
                'Control contains ' + inner.length + ' other interactive control(s); assistive technology ' +
                'cannot expose controls nested inside a control.',
                { inner: inner.slice(0, 6).map(selectorFor) }));
        });
    }

    /** Icons inside a control that are exposed to assistive technology. */
    function ruleDecorativeIcons(root, out) {
        controls(root).forEach(function (el) {
            if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return;
            var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            var glyphs = [];
            for (var node = walker.nextNode(); node; node = walker.nextNode()) {
                var text = node.nodeValue.trim();
                if (!text || HAS_WORD.test(text) || !SYMBOL.test(text)) continue;
                var owner = node.parentElement;
                if (!owner || owner.closest('[aria-hidden="true"]') || !isRendered(owner)) continue;
                // A nested control owns its own text.
                var nearest = owner.closest(INTERACTIVE);
                if (nearest !== el) continue;
                glyphs.push(text);
            }
            if (glyphs.length) {
                out.push(finding('icon-not-hidden', 'fail', '1.1.1', el,
                    'Glyph ' + glyphs.map(function (g) { return '"' + g + '"'; }).join(', ') +
                    ' is used as an icon but is not hidden from assistive technology.',
                    { glyphs: glyphs }));
            }
            Array.prototype.forEach.call(el.querySelectorAll('svg, img'), function (icon) {
                if (!isRendered(icon) || icon.closest('[aria-hidden="true"]')) return;
                if (icon.closest(INTERACTIVE) !== el) return;
                var labelled = icon.getAttribute('aria-label') || icon.getAttribute('aria-labelledby') ||
                    icon.getAttribute('alt') || icon.querySelector('title');
                if (icon.tagName === 'IMG' && icon.hasAttribute('alt')) return;
                if (labelled) return;
                out.push(finding('icon-not-hidden', 'fail', '1.1.1', el,
                    'An <' + icon.tagName.toLowerCase() + '> icon inside this control has neither a text ' +
                    'alternative nor aria-hidden="true".', { icon: selectorFor(icon) }));
            });
        });
    }

    var LIST_PARENTS = 'ul, ol, dl, menu, table, thead, tbody, tfoot, tr, select, datalist, optgroup, ' +
        '[role="list"], [role="listbox"], [role="menu"], [role="menubar"], [role="tablist"], [role="radiogroup"], ' +
        '[role="grid"], [role="table"], [role="rowgroup"], [role="row"], [role="tree"], [role="toolbar"], [role="group"], ' +
        '[role="feed"], fieldset, svg';
    var NOT_LIST_ITEMS = 'li, dt, dd, tr, td, th, option, button, input, select, textarea, label, a, span, ' +
        'br, hr, script, style, svg, path, img, p, h1, h2, h3, h4, h5, h6, section, main, header, footer, nav, ' +
        'fieldset, form, dialog';

    /**
     * Runs of sibling blocks that share a tag and class and each carry their own
     * content: what the eye reads as a list. Flags the run when no list (or
     * equivalent grouping) role is present.
     */
    function ruleListSemantics(root, out) {
        var seen = new Set();
        Array.prototype.forEach.call(root.querySelectorAll('*'), function (parent) {
            if (parent.matches(LIST_PARENTS) || !isExposed(parent)) return;
            var runs = new Map();
            Array.prototype.forEach.call(parent.children, function (child) {
                if (child.matches(NOT_LIST_ITEMS) || !child.classList.length || !isExposed(child)) return;
                if (child.getAttribute('role') === 'listitem') return;
                if (!child.textContent.trim() || !child.firstElementChild) return;
                var key = child.tagName + '.' + child.classList[0];
                if (!runs.has(key)) runs.set(key, []);
                runs.get(key).push(child);
            });
            runs.forEach(function (items, key) {
                if (items.length < 2 || seen.has(parent)) return;
                seen.add(parent);
                out.push(finding('list-semantics', 'review', '1.3.1', parent,
                    items.length + ' sibling "' + key.toLowerCase() + '" blocks look like a list but are not ' +
                    'marked up as one (ul/ol/li or role="list"/"listitem").',
                    { itemSelector: key.toLowerCase(), count: items.length }));
            });
        });
    }

    function ownText(el) {
        var text = '';
        Array.prototype.forEach.call(el.childNodes, function (node) {
            if (node.nodeType === 3) text += node.nodeValue;
        });
        return text.replace(/\s+/g, ' ').trim();
    }

    function textWithoutControls(el) {
        var clone = el.cloneNode(true);
        Array.prototype.forEach.call(clone.querySelectorAll(INTERACTIVE + ', [aria-hidden="true"], [hidden]'), function (n) {
            n.remove();
        });
        return clone.textContent.replace(/\s+/g, ' ').trim();
    }

    /**
     * Short bold text that sits alone on its line and introduces the content
     * after it: a heading by appearance. Flags it when it is not a heading.
     */
    function ruleVisualHeadings(root, out) {
        var bodySize = parseFloat(styleOf(document.body).fontSize) || 16;
        var skipInside = 'h1, h2, h3, h4, h5, h6, [role="heading"], label, legend, th, dt, summary, caption, ' +
            'button, a, [role="button"], figcaption, option, li > :only-child, td, nav, [role="status"], [role="alert"]';
        Array.prototype.forEach.call(root.querySelectorAll('strong, b, span, div, p'), function (el) {
            if (!isExposed(el) || isVisuallyHidden(el) || el.closest(skipInside)) return;
            var text = ownText(el);
            if (text.length < 2 || text.length > 80 || !HAS_WORD.test(text)) return;
            if (el.children.length && ownText(el) !== textWithoutControls(el)) return;
            var style = styleOf(el);
            var weight = parseInt(style.fontWeight, 10) || 400;
            var size = parseFloat(style.fontSize) || bodySize;
            var emphasised = weight >= 600 || size >= bodySize * 1.15;
            if (!emphasised) return;
            // A pill or badge (its own background and padding) is a tag, not a heading.
            var ownBackground = parseColor(style.backgroundColor);
            if (ownBackground && ownBackground[3] > 0 && parseFloat(style.paddingLeft) > 0) return;

            // Climb while this text is the only prose on its line.
            var line = el;
            while (line.parentElement && textWithoutControls(line.parentElement) === text &&
                line.parentElement !== root) {
                line = line.parentElement;
            }
            if (line.closest(skipInside)) return;
            var display = styleOf(line).display;
            var blockLike = display !== 'inline' || line !== el;
            // An inline <strong> still has a line to itself when no text sits
            // beside it and the next thing after it is a block.
            if (!blockLike && !ownText(el.parentElement) && el.nextElementSibling &&
                !/^inline/.test(styleOf(el.nextElementSibling).display) && !el.previousElementSibling) {
                blockLike = true;
            }
            if (!blockLike) return;

            // It must introduce something: later siblings with prose or form fields.
            var introduces = false;
            for (var next = line.nextElementSibling; next; next = next.nextElementSibling) {
                if (!isRendered(next)) continue;
                if (next.textContent.trim() || next.querySelector('input, textarea, select')) { introduces = true; break; }
            }
            if (!introduces) return;
            out.push(finding('visual-heading', 'review', '1.3.1', el,
                '"' + text + '" is styled and positioned like a heading (' + Math.round(size) + 'px, weight ' +
                weight + ') but is not marked up as one.', { text: text, fontSize: size, fontWeight: weight }));
        });
    }

    /** Heading levels that skip, and headings that are not below their section's heading. */
    function ruleHeadingStructure(root, out) {
        var HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"][aria-level]';
        var headings = Array.prototype.filter.call(root.querySelectorAll(HEADINGS), isExposed);
        var levelOf = function (h) {
            return h.hasAttribute('aria-level') ? parseInt(h.getAttribute('aria-level'), 10) : parseInt(h.tagName.slice(1), 10);
        };
        var previous = 0;
        headings.forEach(function (h) {
            var level = levelOf(h);
            if (previous && level > previous + 1) {
                out.push(finding('heading-level-skip', 'fail', '1.3.1', h,
                    'Heading level jumps from h' + previous + ' to h' + level + '.', { level: level, previous: previous }));
            }
            previous = level;

            // Find the heading whose section this one sits in. Climbing from the
            // heading, look at what comes before it at each level: a preceding
            // block that looks like the one we are in (same tag and class) is a
            // peer, such as the previous card in a list of cards, and tells us
            // nothing. A preceding block that looks different and holds exactly
            // one heading is the header of the section we are inside.
            var signature = function (el) { return el.tagName + '.' + (el.classList[0] || ''); };
            var isHeading = function (el) { return el.matches(HEADINGS); };
            var branch = h;
            for (var box = h.parentElement; box && box !== document.documentElement; branch = box, box = box.parentElement) {
                var owner = null;
                for (var prev = branch.previousElementSibling; prev && !owner; prev = prev.previousElementSibling) {
                    var inside = isHeading(prev) ? [prev] : Array.prototype.filter.call(prev.querySelectorAll(HEADINGS), isExposed);
                    if (!inside.length || !isExposed(prev)) continue;
                    var peer = signature(prev) === signature(branch) || (isHeading(prev) && isHeading(branch));
                    // Another landmark (site header, nav, sidebar) is not this content's section.
                    var otherLandmark = prev.matches('header, nav, aside, footer, [role="banner"], [role="navigation"], [role="complementary"]');
                    if (peer || otherLandmark || inside.length !== 1) break;
                    owner = inside[0];
                }
                if (!owner) continue;
                if (level <= levelOf(owner)) {
                    out.push(finding('heading-not-nested', 'review', '1.3.1 / 2.4.6', h,
                        'This h' + level + ' sits inside the section headed by the h' + levelOf(owner) + ' "' +
                        owner.textContent.trim().slice(0, 60) + '", so it should be a lower level.',
                        { level: level, sectionLevel: levelOf(owner) }));
                }
                break;
            }
        });
    }

    function targetBox(el) {
        var rect = el.getBoundingClientRect();
        var box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        // A native field's label is part of its pointer target.
        var labels = el.labels ? Array.prototype.slice.call(el.labels) : [];
        labels.forEach(function (label) {
            if (!isRendered(label)) return;
            var r = label.getBoundingClientRect();
            if (!r.width || !r.height) return;
            box.left = Math.min(box.left, r.left); box.top = Math.min(box.top, r.top);
            box.right = Math.max(box.right, r.right); box.bottom = Math.max(box.bottom, r.bottom);
        });
        box.width = box.right - box.left; box.height = box.bottom - box.top;
        return box;
    }

    /** Pointer targets smaller than 24 by 24 CSS pixels with no spacing exception. */
    function ruleTargetSize(root, out) {
        var all = controls(document.body).filter(function (el) { return !el.disabled; });
        var boxes = new Map(all.map(function (el) { return [el, targetBox(el)]; }));
        controls(root).forEach(function (el) {
            if (el.disabled) return;
            var box = boxes.get(el) || targetBox(el);
            if (!box.width || !box.height) return;
            if (box.width >= 24 && box.height >= 24) return;
            // Inline exception: a link inside a sentence.
            if (el.matches('a') && styleOf(el).display === 'inline' && ownText(el.parentElement).length > 0) return;
            // Spacing exception: a 24px circle centred on the target must not
            // touch another target or another undersized target's circle.
            var cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
            var crowded = all.some(function (other) {
                if (other === el || other.contains(el) || el.contains(other)) return false;
                var o = boxes.get(other);
                if (!o || !o.width || !o.height) return false;
                var dx = Math.max(o.left - cx, 0, cx - o.right), dy = Math.max(o.top - cy, 0, cy - o.bottom);
                return Math.sqrt(dx * dx + dy * dy) < 12;
            });
            out.push(finding('target-size', crowded ? 'fail' : 'review', '2.5.8', el,
                'Pointer target is ' + Math.round(box.width) + ' by ' + Math.round(box.height) + ' CSS px; the minimum is 24 by 24' +
                (crowded ? ' and another target is too close for the spacing exception.' : ' (spacing exception may apply).'),
                { width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10, crowded: crowded }));
        });
    }

    // ---------------------------------------------------------------- contrast

    function parseColor(value) {
        var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value || '');
        if (!m) return null;
        var a = m[4] === undefined ? 1 : (/%$/.test(m[4]) ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
        return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), a];
    }

    function over(top, bottom) {
        var a = top[3];
        return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
    }

    function mix(from, to, t) {
        return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t, 1];
    }

    function luminance(c) {
        var ch = [c[0], c[1], c[2]].map(function (v) {
            v /= 255;
            return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    }

    function ratio(a, b) {
        var la = luminance(a), lb = luminance(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    }

    function hex(c) {
        return '#' + [c[0], c[1], c[2]].map(function (v) {
            return Math.round(v).toString(16).padStart(2, '0');
        }).join('');
    }

    /**
     * Paints the element's ancestor chain the way the browser does: each
     * ancestor's background over what is behind it, with `opacity` fading the
     * whole group. Returns null when a background image makes the colour
     * unknowable from styles alone.
     */
    function paintedColors(el, textColor) {
        var chain = [];
        for (var node = el; node && node.nodeType === 1; node = node.parentElement) chain.unshift(node);
        var unknown = false;
        function resolve(index, backdrop, withText) {
            var style = styleOf(chain[index]);
            var bg = parseColor(style.backgroundColor);
            var color = backdrop;
            if (style.backgroundImage && style.backgroundImage !== 'none') unknown = true;
            if (bg && bg[3] > 0) { color = over(bg, backdrop); if (bg[3] === 1) unknown = false; }
            if (index < chain.length - 1) color = resolve(index + 1, color, withText);
            else if (withText) color = over(textColor, color);
            var opacity = parseFloat(style.opacity);
            return isNaN(opacity) || opacity >= 1 ? color : mix(backdrop, color, opacity);
        }
        var white = [255, 255, 255, 1];
        var background = resolve(0, white, false);
        if (unknown) return null;
        return { background: background, foreground: resolve(0, white, true) };
    }

    /**
     * Text contrast for every rendered text node, including text inside
     * disabled controls. WCAG 1.4.3 exempts inactive components, and axe skips
     * them, so those are reported under their own rule id and tier.
     */
    function ruleTextContrast(root, out) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        var done = new Set();
        for (var node = walker.nextNode(); node; node = walker.nextNode()) {
            var el = node.parentElement;
            if (!el || done.has(el) || !node.nodeValue.trim()) continue;
            done.add(el);
            if (el.closest('script, style, noscript, option, title') || !isRendered(el) || isVisuallyHidden(el)) continue;
            var style = styleOf(el);
            var fg = parseColor(style.color);
            if (!fg) continue;
            var painted = paintedColors(el, fg);
            if (!painted) continue;
            var size = parseFloat(style.fontSize);
            var weight = parseInt(style.fontWeight, 10) || 400;
            // House rule: 4.5:1 for all text, whatever its size. WCAG's 3:1
            // allowance for large text is opt-in (options.largeTextAt3).
            var large = size >= 24 || (size >= 18.66 && weight >= 700);
            var needed = large && OPTIONS.largeTextAt3 ? 3 : 4.5;
            var actual = ratio(painted.foreground, painted.background);
            if (actual >= needed) continue;
            var inactive = !!el.closest(':disabled, [aria-disabled="true"]');
            out.push(finding(inactive ? 'text-contrast-inactive' : 'text-contrast', inactive ? 'review' : 'fail',
                inactive ? '1.4.3 (inactive components are exempt)' : '1.4.3', el,
                'Text "' + node.nodeValue.trim().slice(0, 40) + '" has contrast ' + actual.toFixed(2) + ':1 (' +
                hex(painted.foreground) + ' on ' + hex(painted.background) + '); needs ' + needed + ':1.',
                { ratio: Math.round(actual * 100) / 100, needed: needed, foreground: hex(painted.foreground),
                    background: hex(painted.background), text: node.nodeValue.trim().slice(0, 60), inactive: inactive }));
        }
    }

    /** Fields named only by a placeholder, and fields with no label a sighted user can see. */
    function ruleFieldLabels(root, out) {
        Array.prototype.forEach.call(root.querySelectorAll('input, textarea, select'), function (el) {
            if (!isExposed(el)) return;
            var type = (el.getAttribute('type') || '').toLowerCase();
            if (el.tagName === 'INPUT' && TEXT_FIELD_TYPES.indexOf(type) === -1) return;
            var labels = el.labels ? Array.prototype.filter.call(el.labels, function (l) {
                return isRendered(l) && l.textContent.trim();
            }) : [];
            var labelledby = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
                .map(function (id) { return document.getElementById(id); })
                .filter(function (n) { return n && n.textContent.trim(); });
            var ariaLabel = (el.getAttribute('aria-label') || '').trim();
            var title = (el.getAttribute('title') || '').trim();
            var placeholder = (el.getAttribute('placeholder') || '').trim();
            if (!labels.length && !labelledby.length && !ariaLabel && !title) {
                out.push(finding('field-name-missing', 'fail', '4.1.2 / 1.3.1', el,
                    placeholder
                        ? 'Field is named only by its placeholder "' + placeholder + '", which vanishes on input and is not a reliable accessible name.'
                        : 'Field has no accessible name.', { placeholder: placeholder }));
            }
            var visibleLabel = labels.some(function (l) { return !isVisuallyHidden(l); }) ||
                labelledby.some(function (n) { return isRendered(n) && !isVisuallyHidden(n); });
            if (!visibleLabel) {
                out.push(finding('field-label-not-visible', 'fail', '3.3.2', el,
                    'Field has no visible label; a placeholder or aria-label alone does not tell sighted users what to enter once they start typing.',
                    { placeholder: placeholder, ariaLabel: ariaLabel }));
            }
        });
    }

    /** Live regions should carry text only: controls inside them are read out as part of the message. */
    function ruleLiveRegions(root, out) {
        var sel = '[role="status"], [role="alert"], [role="log"], [aria-live="polite"], [aria-live="assertive"]';
        Array.prototype.forEach.call(root.querySelectorAll(sel), function (region) {
            if (region.getAttribute('role') === 'log') return;
            var inner = Array.prototype.filter.call(region.querySelectorAll(INTERACTIVE), isRendered);
            if (!inner.length) return;
            out.push(finding('live-region-has-controls', 'fail', '4.1.3', region,
                'Live region contains ' + inner.length + ' interactive control(s); their names are announced as part of every message.',
                { controls: inner.slice(0, 5).map(function (c) { return nameOf(c) || selectorFor(c); }) }));
        });
    }

    /** House pattern: a control is named by text inside it, not by aria-label / aria-labelledby. */
    function ruleNamedByAria(root, out) {
        controls(root).forEach(function (el) {
            var attr = el.hasAttribute('aria-labelledby') ? 'aria-labelledby' : (el.hasAttribute('aria-label') ? 'aria-label' : '');
            if (!attr) return;
            out.push(finding('control-named-by-aria', 'house', 'house: controls', el,
                'Control is named with ' + attr + '. Name it with text inside the control (visually hidden where needed) instead.',
                { attribute: attr }));
        });
    }

    /** House pattern: lists keep their native semantics with no role and no list-style override. */
    function ruleListMarkup(root, out) {
        Array.prototype.forEach.call(root.querySelectorAll('ul, ol'), function (list) {
            if (!isExposed(list)) return;
            var items = Array.prototype.filter.call(list.children, function (c) { return c.tagName === 'LI' && isRendered(c); });
            if (!items.length) return;
            var problems = [];
            if (list.hasAttribute('role')) problems.push('has role="' + list.getAttribute('role') + '"');
            if (styleOf(items[0]).listStyleType === 'none') problems.push('uses list-style: none');
            if (styleOf(items[0]).display !== 'list-item') problems.push('its items are display: ' + styleOf(items[0]).display + ', not list-item');
            if (!problems.length) return;
            out.push(finding('list-markup', 'house', 'house: lists', list,
                'List ' + problems.join(', ') + '. Keep list-item display and hide bullets with a tiny transparent ::marker instead.',
                { problems: problems }));
        });
    }

    /** House pattern: every heading has an id and tabindex="-1" so focus can be sent to it. */
    function ruleHeadingAttributes(root, out) {
        Array.prototype.forEach.call(root.querySelectorAll('h1, h2, h3, h4, h5, h6'), function (h) {
            if (!isExposed(h)) return;
            var missing = [];
            if (!h.id) missing.push('id');
            if (h.getAttribute('tabindex') !== '-1') missing.push('tabindex="-1"');
            if (!missing.length) return;
            out.push(finding('heading-attributes', 'house', 'house: headings', h,
                'Heading "' + h.textContent.trim().slice(0, 50) + '" is missing ' + missing.join(' and ') + '.',
                { missing: missing }));
        });
    }

    var OPTIONS = { largeTextAt3: false };

    var RULES = {
        'control-named-by-aria': ruleNamedByAria,
        'list-markup': ruleListMarkup,
        'heading-attributes': ruleHeadingAttributes,
        'control-names': ruleControlNames,
        'control-name-duplicate': ruleDuplicateNames,
        'nested-interactive': ruleNestedInteractive,
        'icon-not-hidden': ruleDecorativeIcons,
        'list-semantics': ruleListSemantics,
        'visual-heading': ruleVisualHeadings,
        'heading-structure': ruleHeadingStructure,
        'target-size': ruleTargetSize,
        'text-contrast': ruleTextContrast,
        'field-labels': ruleFieldLabels,
        'live-regions': ruleLiveRegions
    };

    /**
     * @param {{ root?: string, rules?: string[], largeTextAt3?: boolean }} [options]
     * @returns {Array<object>} findings
     */
    function audit(options) {
        options = options || {};
        OPTIONS.largeTextAt3 = !!options.largeTextAt3;
        var root = options.root ? document.querySelector(options.root) : document.body;
        if (!root) throw new Error('a11y toolkit: root not found: ' + options.root);
        var names = options.rules || Object.keys(RULES);
        var out = [];
        withAxe(function () {
            names.forEach(function (name) {
                if (!RULES[name]) throw new Error('a11y toolkit: unknown rule ' + name);
                RULES[name](root, out);
            });
        });
        return out;
    }

    /** Role, name and state of one element, as assistive technology would get them. */
    function describe(el) {
        return withAxe(function () {
            return {
                selector: selectorFor(el),
                role: roleOf(el),
                name: nameOf(el),
                expanded: el.getAttribute('aria-expanded'),
                pressed: el.getAttribute('aria-pressed'),
                checked: 'checked' in el ? el.checked : el.getAttribute('aria-checked'),
                disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
                rendered: isRendered(el)
            };
        });
    }

    window.__a11yToolkit = {
        audit: audit,
        describe: describe,
        selectorFor: selectorFor,
        isRendered: isRendered,
        INTERACTIVE: INTERACTIVE
    };
})();
