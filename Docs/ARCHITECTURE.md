# DeSlop: Technical Architecture & Data Flow

```text
+-----------------------------------------------------------------+
|                       YOUTUBE DOM CONTAINER                     |
|  - Infinite Scroll MutationObserver                             |
|  - Video Card Renderers (ytd-rich-item-renderer, etc.)          |
+--------------------------------|--------------------------------+
                                 ▼
+-----------------------------------------------------------------+
|                      CONTENT SCRIPT (content.js)                |
|  - Extracts Title, Channel Name, and Metadata                   |
|  - Evaluates against Regex Engine & Channel Blocklist           |
+--------------------------------|--------------------------------+
                                 ▼
+-----------------------------------------------------------------+
|                        SLOP EVALUATION                          |
|  [Is AI Voice Slop?]   [Is Corporate Challenge?]   [Blocked?]   |
+--------------------------------|--------------------------------+
                                 ▼
+-----------------------------------------------------------------+
|                       DOM MUTATION ACTION                       |
|  - Apply Opacity Reduction (0.1) & Pointer-Events: None         |
|  - Inject "DeSlop Filtered" Indicator Badge                     |
+-----------------------------------------------------------------+