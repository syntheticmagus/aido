# Project: TodoApp

## Overview
A simple command-line todo list application for tracking tasks. Users can add, list, complete, and delete tasks. Data is persisted to a local JSON file so tasks survive between sessions.

## Technical Requirements
- Language / runtime: Node.js 20 + TypeScript
- No external frameworks required — use Node.js built-ins only
- Compiled output should be a single `dist/index.js` runnable with `node dist/index.js`

## Features

### Feature 1: Add a task
Users can add a new task with a title:
```
node dist/index.js add "Buy groceries"
# Output: Added task #1: Buy groceries
```

### Feature 2: List tasks
Users can list all tasks, showing ID, status, and title:
```
node dist/index.js list
# Output:
# [ ] 1. Buy groceries
# [x] 2. Call dentist (completed)
```

### Feature 3: Complete a task
Users can mark a task as done by ID:
```
node dist/index.js done 1
# Output: Marked task #1 as complete.
```

### Feature 4: Delete a task
Users can remove a task by ID:
```
node dist/index.js delete 2
# Output: Deleted task #2.
```

## Non-Functional Requirements
- All operations must complete in under 100ms
- Graceful error messages for invalid task IDs or missing arguments
- Tasks file stored at `~/.todoapp/tasks.json`

## Deliverables
- TypeScript source in `src/`
- Compiled output runnable with `node dist/index.js <command>`
- A `package.json` with a `build` script

## Constraints
- No external npm dependencies
- No web server or HTTP API — CLI only
