# ProxiPrompt mobile design

ProxiPrompt is a mobile app for knowing what a place is like before you go. The interface uses iOS conventions: large system-font titles, rounded grouped surfaces, persistent bottom navigation, generous touch targets, and a responder sheet that preserves the current screen.

## Foundation

The app fills a phone viewport and is centered in a 460px column on desktop. Respect top and bottom safe areas. Use 24px horizontal padding (18px on narrow phones), 44px minimum controls, and 54px primary actions. Inputs use at least 16px text to avoid iOS focus zoom.

Use the system font stack; headings are bold, tightly spaced sans serif. Headings stand alone; explanatory copy stays sentence case. Cards use 16px corners and controls use 12–16px corners.

The palette is strictly neutral: white, gray, and charcoal, with no hue accents. Branding is deferred: show the plain product name, with no assumed logo or stylized wordmark. The installable app icon is a text-only placeholder. High/Medium/Low retain explicit written labels and distinct neutral fills.

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
