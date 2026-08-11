# DeSlop: Development Roadmap

## Phase 1: Local Prototype & Extension Shell (Current Milestone)
*   [x] Define extension scope and detection heuristics.
*   [ ] Initialize Manifest V3 structure (`manifest.json`).
*   [ ] Build core `content.js` with `MutationObserver` to handle YouTube's Single Page Application (SPA) infinite scroll.
*   [ ] Implement basic title regex filtering for corporate challenge formats and AI voice slop keywords.

## Phase 2: State Management & UI Popup
*   [ ] Build popup HTML/CSS interface (`popup.html`) for user controls.
*   [ ] Implement chrome storage sync so users can toggle specific filter categories (e.g., "Block AI Voice Slop", "Block Corporate Challenge Slop").
*   [ ] Add a custom "Whitelist Channel" and "Manual Report" feature via right-click context menu.

## Phase 3: Community Crowdsourced Lists
*   [ ] Design lightweight backend (Supabase / JSON endpoint) for global slop channel reporting.
*   [ ] Implement background worker (`background.js`) to fetch daily updated community blocklists.

## Phase 4: Polish & Distribution
*   [ ] Conduct memory and performance profiling to ensure zero lag during fast YouTube scrolling.
*   [ ] Package extension for Chrome Web Store and Firefox Add-ons submission.