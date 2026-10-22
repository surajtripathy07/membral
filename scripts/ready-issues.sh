#!/usr/bin/env bash
# List open issues that are ready to work: unassigned and not blocked by any open issue.
# Usage: scripts/ready-issues.sh [label]     e.g. scripts/ready-issues.sh P1
set -euo pipefail

OWNER=$(gh repo view --json owner --jq '.owner.login')
NAME=$(gh repo view --json name --jq '.name')
FILTER="${1:-}"

gh api graphql --paginate -f owner="$OWNER" -f name="$NAME" -f query='
query($owner:String!, $name:String!, $endCursor:String) {
  repository(owner:$owner, name:$name) {
    issues(states:OPEN, first:100, after:$endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        assignees(first:1) { totalCount }
        labels(first:20) { nodes { name } }
        issueDependenciesSummary { blockedBy }
      }
    }
  }
}' --jq '.data.repository.issues.nodes[]' |
jq -rs --arg f "$FILTER" '
  map(select(.issueDependenciesSummary.blockedBy == 0 and .assignees.totalCount == 0))
  | map(. + {prio: ((.labels.nodes | map(.name) | map(select(startswith("P"))) | first) // "P?")})
  | map(select($f == "" or (.labels.nodes | map(.name) | index($f))))
  | sort_by(.prio, .number)
  | .[] | "#\(.number)\t\(.prio)\t\(.title)"'
