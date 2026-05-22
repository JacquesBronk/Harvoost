---
run_id: {{run_id}}
slug: {{slug}}
mode: {{mode}}
parent_run_id: {{parent_run_id}}
prompt_summary: "{{prompt_summary}}"
created_at: {{created_at}}
current_phase: intake
deploy_target: pending
status: in_progress
---

# Phase ledger

| # | phase          | agent(s)              | status     | artifacts                       | gate         |
|---|----------------|-----------------------|------------|---------------------------------|--------------|
| 1 | intake         | product-analyst       | ○ pending  | —                               | interview    |
| 2 | architecture   | architect             | ○ pending  | —                               | approve_arch |
| 3 | api_design     | api-designer          | ○ pending  | —                               | —            |
| - | secrets_intake | —                     | ○ pending  | —                               | secrets      |
| 4 | build          | (assigned at phase)   | ○ pending  | —                               | —            |
| 5 | test           | tester + e2e-tester   | ○ pending  | —                               | —            |
| 6 | review         | code-rev + sec-rev    | ○ pending  | —                               | —            |
| 7 | deploy         | devops                | ○ pending  | —                               | predeploy    |
| 8 | docs           | docs + changelog      | ○ pending  | —                               | —            |

# Open items
(none yet)

# Decision log
- {{created_at}} run created (mode={{mode}})
