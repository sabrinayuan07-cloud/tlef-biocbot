# Accessibility check toolkit

Generic, application-agnostic accessibility checks used by
`../issue-724-course-upload.a11y.spec.js`.

This is a copy of the toolkit kept in
[ubc/ltic-accessibility-skills](https://github.com/ubc/ltic-accessibility-skills/tree/main/toolkit).
The rules it checks, the tiers (`fail` / `review` / `house`), and the API are
documented there, alongside the accessibility skill (`accessibility.md`) the
rules come from. Change the toolkit there first and copy it here.

Run the Course Upload checks:

```sh
npx playwright test --config=playwright.a11y.config.js tests/a11y/issue-724-course-upload.a11y.spec.js
```

Each test writes what it measured to `a11y-results/issue-724/<run>/` (set
`A11Y_EVIDENCE_RUN` to name the run). If your dev server runs under nodemon,
point the tests at their own server (`TLEF_BIOCBOT_PORT=8052`): writing those
JSON files inside the repository restarts a nodemon-watched server mid-run.
