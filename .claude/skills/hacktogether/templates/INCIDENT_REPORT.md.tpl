# Incident {{inc_id}} — {{slug}}

## Reporter description (verbatim)
> {{user description from /hacktogether_incident}}

## Triage
- **Severity:** sev-1 | sev-2 | sev-3
- **Scope:** {{affected modules / endpoints / users}}
- **Reproduction:** {{steps to reproduce, or "could not reproduce"}}
- **Blast radius:** {{e.g., "all users hit on slug paths containing /"}}
- **Rollback recommended:** yes | no — {{rationale}}

## Initial hypothesis
{{best guess at cause, to seed debugger}}

## Next step
- If rollback: revert to prior deploy artifact, halt for user confirmation.
- Else: dispatch debugger to write ROOT_CAUSE.md and HOTFIX_PLAN.md.
