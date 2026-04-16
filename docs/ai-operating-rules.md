# AI Operating Rules

## Purpose

These rules exist so AI tools can safely assist with this repo without creating production drift.

## System of truth

- GitHub is the source of truth for code, Docker Compose, Dockerfiles, and workflows.
- Coolify is the source of truth for production runtime environment variables and deployment target settings.
- The production server is only a runtime host, not a configuration source.

## Branch policy

- This repo uses one branch only: `main`
- Do not propose or create feature branches
- Do not suggest branch-based workflows
- Do not assume there is a staging branch
- All approved changes should target `main`

## Approved deployment path

The only normal deployment path is:

1. Change files in this repo
2. Commit to `main`
3. GitHub Actions builds and pushes the image
4. GitHub Actions triggers Coolify
5. Coolify deploys the new image

Do not propose alternate routine deployment methods.

## Allowed AI actions

AI may help with:

- Editing application code
- Editing `docker-compose.yml`
- Editing Dockerfiles
- Editing GitHub Actions workflows
- Editing documentation
- Recommending GitHub Secrets usage for CI/CD
- Recommending Coolify runtime environment variable changes
- Triggering deployment through the approved GitHub → Coolify path

## Forbidden AI actions

AI must not:

- Use SSH as the normal deployment path
- Hand-edit files directly on the production server
- Assume the server contains the source of truth
- Create undocumented hotfixes on the live machine
- Introduce additional branches
- Create a second deployment system
- Recommend storing production runtime configuration only in ad hoc server files

## Secrets rule

- GitHub Secrets are for CI/CD and build-time secrets
- Coolify stores production runtime environment variables
- Do not move all runtime secrets into GitHub if the running app is managed by Coolify

## Compose rule

- The repo copy of `docker-compose.yml` is authoritative
- If a service exists, it should be declared in the repo
- Do not assume server-side Compose changes are valid unless they are committed

## Change discipline

When making changes:

- Prefer small, explicit edits
- Preserve the single-branch workflow
- Keep deployment logic simple
- Avoid introducing tools or processes that require manual server babysitting

## Decision preference

When multiple valid options exist, prefer the option that:

- Keeps `main` as the single source of truth
- Keeps production behavior reproducible
- Reduces hidden state on the server
- Is easier for a non-developer owner to understand and audit
