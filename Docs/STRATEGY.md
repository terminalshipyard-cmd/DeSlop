# DeSlop: Extension Strategy & Detection Philosophy

## 1. The Core Mission
The modern YouTube recommendation engine heavily rewards algorithmic CTR (Click-Through Rate) hacks, leading to an over-saturation of content pollution:
*   **AI Slop:** Mass-produced automated channels leveraging synthetic text-to-speech (ElevenLabs), AI-generated scripts, and stock visuals.
*   **Corporate Slop ("Beastification"):** Industrialized human-led content farms relying on hyper-saturated open-mouth face thumbnails, artificial challenge premises, and hyper-dense ad-break pacing.

**DeSlop** aims to restore user agency by filtering out content farms locally and transparently in the browser, shifting user feeds back toward human-made, organic media.

## 2. Multi-Tiered Detection Vectors
To accurately catch content pollution without breaking YouTube's layout, DeSlop uses a layered heuristic approach:
1.  **Lexical & Structural Regex Matching:** Instantly flags known psychological phrasing formulas in video titles (e.g., *“I spent $X in Y”*, *“Things you didn’t know about...”*).
2.  **Channel Fingerprinting:** Maintains a local and community-updated blacklist of known automated cash-cow operations and content conglomerates.
3.  **DOM Heuristics:** Scans for structural metadata patterns indicative of low-effort batch uploading.
4.  **UX Philosophy (Dim, Don't Destroy):** Instead of abruptly deleting DOM elements (which causes layout reflow jitter), blocked videos are styled down to low opacity with a discrete badge, allowing user auditing.