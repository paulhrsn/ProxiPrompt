# ProxiPrompt mobile design

ProxiPrompt is a mobile app for knowing what a place is like before you go. The interface uses iOS conventions: large system-font titles, rounded grouped surfaces, persistent bottom navigation, generous touch targets, and a responder sheet that preserves the current screen.

## Foundation

The app fills a phone viewport and is centered in a 460px column on desktop. Respect top and bottom safe areas. Use 24px horizontal padding (18px on narrow phones), 44px minimum controls, and 54px primary actions. Inputs use at least 16px text to avoid iOS focus zoom.

Use the system font stack; headings are bold, tightly spaced sans serif. Headings stand alone; explanatory copy stays sentence case. Cards use 16px corners and controls use 12–16px corners.

The palette is a dark forest background (`--bg: #0d1410`) with warm white text and a mint accent (`--accent: #80d3aa`); the tokens live at the top of `apps/web/src/styles.css`. The header shows the question-mark pin logo (`apps/web/public/logo.png`, also the installable app icon) beside the product name. High/Medium/Low retain explicit written labels as well as color.

## Screens

- Ask: a clear invitation, compact selected-place card, expandable place search, question composer with editable starters, Ask, and an optional watch action.
- Questions: saved questions, status, evidence, and active watches. Entire question cards are keyboard-accessible buttons. Empty states explain the next action.
- Posts: full-width sort segment, place filters, an obvious update composer, and readable individual post cards.
- You: identity, location, privacy, notifications, and demo controls in grouped rows. Simulated location stays explicitly labeled.
- Respond: a rounded sheet over the current screen, large radio choices, optional note, Send, and Not now.

Keep the four destinations Ask / Questions / Posts / You. Show selected navigation with both a background and aria-current. Preserve evidence confidence, provenance, insufficient-evidence states, and the real-time backend contracts.

## Motion

Press feedback scales to 0.97 over 150ms. Tab screens appear immediately; composer entrances use a 6px translation with opacity over 180ms. The responder sheet uses 280ms with the iOS-style cubic-bezier(.32,.72,0,1). Only transforms and opacity animate spatially; no looping decorative animations. Reduced motion replaces entrances with a short fade and removes press scaling. Gate new hover effects to fine pointers.

## Interaction refinements

The responder's successful contribution is the focal motion: a brief checkmark draw with a polite status announcement. It confirms a completed submission without delaying the real result. Sending disables repeated submission and shows a truthful pending label. Response progress reflects actual selected answers, and actions remain sticky inside a long responder sheet.

The tab highlight slides between destinations over 240ms; keyboard focus changes it immediately. Question starters visibly retain selection until edited. Place search fades into view and its disclosure chevron turns. Reduced motion uses a short success fade with a static checkmark and instant navigation highlights.

Layout uses 8px tight spacing, 16px within groups, and 24px between sections. Place name and Change occupy separate grid columns, with the address spanning both. Question starters wrap on small screens instead of hiding an option in a horizontal scroller. No new brand elements or colors are introduced.

The signed-out demo welcome uses its own full-height layout: a two-line headline and short explanation form one group, with the entry action and next-step hint near the bottom. It does not inherit composer spacing. Hide the developer-session shortcut on this screen when the demo action already provides entry.

## Profile and settings clarity

The profile groups identity, current location, location choice, notifications, developer tools, and sign-out under explicit headings. Explain that location supports nearby matching and that precise coordinates are not shown to other users. Label simulated locations and show the selected place separately. Request location permission only through the location choice, and push permission only through its explicit enable action. Keep demo-session and activity-clearing controls inside Developer tools; state the shared activity that clearing removes.


Post composition shows the chosen place, labels attribution as “Post as,” states who will see the author’s name, and explains which required input is still missing when Post is disabled. Developer settings use explicit wrapped rows for diagnostic switches and destructive activity controls.
