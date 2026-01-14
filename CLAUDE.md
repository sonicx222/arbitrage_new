# Bash commands
- npm run build: Build the project
- npm run typecheck: Run the typechecker
- npm test: Run all tests

# Code style
- Use ES modules (import/export) syntax, not CommonJS (require)
- Make use of npm workspace packages where necessary to structure the modules in a clean way

# Workflow
- Write tests first following TDD
- Stick to the existing architecture design and implementation structure
- ALWAYS read and understand relevant files before proposing edits. Do not speculate about code you have not inspected
- Understand the data flow. Then propose a fix
- Be sure to typecheck when you're done making a series of code changes