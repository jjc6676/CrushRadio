# Project Architecture: CrushRadio

## Overview
CrushRadio is a web-based application designed to provide users with a seamless experience for discovering, playing, and managing online radio and YouTube audio streams. The project is structured for modularity, scalability, and maintainability, with a clear separation of concerns between UI components, backend endpoints, and helper utilities.

## Directory Structure
- `components/`: React components for UI elements.
- `endpoints/`: API endpoints, including integrations (e.g., YouTube).
- `helpers/`: Utility functions and shared logic.
- `pages/`: Next.js pages for routing and rendering views.
- `global.css`, `CombiniSetup.css`: Global and setup-specific styles.

## Key Concepts
- **Component-based UI**: Modular React components for reusability.
- **API Endpoints**: Serverless functions for backend logic (e.g., YouTube audio extraction).
- **Helpers**: Shared logic for data processing and API integration.

## Extensibility
- New integrations (e.g., other streaming services) can be added via new endpoints and helpers.
- UI can be extended by adding new components and pages.

## Error Handling & Robustness
- API endpoints should validate input and handle errors gracefully.
- UI components should display user-friendly error messages.

## Future Considerations
- Authentication for personalized features.
- User playlists and favorites.
- Enhanced search and recommendation features.

---
