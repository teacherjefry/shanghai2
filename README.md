# SHANGHAI V2 — Shanghai Session Scorekeeper

Mobile-first HTML/CSS/JavaScript scorekeeper for the Shanghai card-game session.

## Storage: Firebase Firestore only

This version stores the application's session data, settings, current session, and previous sessions in **Firebase Firestore**. IndexedDB is not used by the application for persistence.

Stored in Firestore:
- Current/active session ID
- Player names
- Scores for all 7 rounds
- Current round
- Session date
- Session completion state
- Completed-session history
- Theme/settings

Firestore collections:
- `shanghaiSessions` — one document per session
- `shanghaiMeta/appState` — active session ID and application settings

The app uses Firestore realtime listeners so the active session, settings, and previous-session history stay synchronized with the cloud.

## Rules implemented

1. Round 1 — 2 Sets
2. Round 2 — 1 Set + 1 Run
3. Round 3 — 2 Runs
4. Round 4 — 3 Sets
5. Round 5 — 2 Sets + 1 Run
6. Round 6 — 1 Set + 2 Runs
7. Round 7 — 3 Runs

The lowest total score is the winner.

## Files

- `shanghai.html` — main mobile app
- `app.js` — application logic and Firestore persistence
- `README.md` — this documentation
- `shanghai-logo.png` — supplied app logo

## Important

The Firebase project configured in `app.js` must have Firestore enabled and its Firestore security rules must permit the reads/writes used by this app.

The Firebase configuration is the project configuration supplied for SHANGHAI 2.
