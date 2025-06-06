# Technical Documentation: CrushRadio

## Stack
- **Frontend**: React (with Next.js)
- **Backend**: Serverless API endpoints (Node.js)
- **Styling**: CSS (global.css, CombiniSetup.css)

## Directory Overview
- `components/`: Contains all UI components.
- `endpoints/`: Contains backend API endpoints (e.g., YouTube integration).
- `helpers/`: Utility functions for data processing and API calls.
- `pages/`: Next.js pages for routing.

## Key Technical Decisions
- Use of Next.js for SSR and routing.
- Modular separation of UI, API, and helpers for maintainability.
- Serverless endpoints for scalability and ease of deployment.

## Error Handling
- API endpoints should return clear error messages and status codes.
- UI should handle and display errors gracefully.

## Extending the Codebase
- Add new endpoints in `endpoints/` for new integrations.
- Add new components in `components/` for UI features.
- Use `helpers/` for shared logic.

## Testing & Quality
- Manual and automated testing recommended for endpoints and components.
- Linting and code formatting for consistency.

---
