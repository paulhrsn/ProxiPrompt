---
name: ProxiPrompt
description: A phone for asking what a place is like right now.
colors:
  mist: "#e8edf2"
  sheet: "#f7f9fb"
  ink: "#121820"
  muted: "#2f3b4a"
  line: "#d3dbe3"
  capsule: "#171c24"
  phosphor: "#d7f07a"
  capsule-ink: "#e7eef6"
  capsule-dim: "#c5d0dc"
  high: "#1c6b38"
  medium: "#7a4e0d"
  low: "#8d2f32"
  error-on-capsule: "#ffb4ae"
typography:
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "-0.02em"
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  capsule-title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  readout:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.03em"
rounded:
  control: "14px"
  capsule: "20px"
  sheet: "16px"
  tab-segment: "12px"
spacing:
  screen-x: "20px"
  stack: "16px"
  control-height: "48px"
  tap: "44px"
components:
  button-primary:
    backgroundColor: "{colors.capsule}"
    textColor: "{colors.phosphor}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "52px"
    width: "100%"
  button-primary-hover:
    backgroundColor: "#232a34"
    textColor: "{colors.phosphor}"
  status-capsule:
    backgroundColor: "{colors.capsule}"
    textColor: "{colors.capsule-ink}"
    rounded: "{rounded.capsule}"
    padding: "22px 18px 18px"
  field:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "48px"
    padding: "12px 14px"
  tab-bar:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.muted}"
    height: "56px"
---

## Overview

ProxiPrompt is a phone-width app. The screen is a live status for a place: a charcoal capsule names the place or the answer, the question sits in a white field, and Ask is a full-width phosphor control above three thumb tabs (Ask, Posts, You). Pushed screens (a question, a place, your questions) use a back control. A prompt arrives as a sheet over the current screen.

## Colors

The ground is cool mist, not warm paper. Raised fields are white. The only dark region is the status capsule. Phosphor is reserved for the live readout and the Ask control. Confidence uses high, medium, and low. Errors on the mist are low; errors inside the capsule are error-on-capsule.

## Typography

One system sans. Titles are 28px at weight 650. The capsule title is 26px white. The live readout is 20px phosphor. Labels are 13px. Body is 16px. Do not introduce a serif or a display face.

## Layout

The column is 430px, centered, with 20px side padding and safe-area insets. Root screens keep the tab bar. The Ask control sits at the bottom of a short ask screen, above the tabs. Content scrolls under a fixed tab bar. Do not add a second navigation row.

## Elevation & Depth

Flat surfaces. The prompt sheet is the one shadow: offset upward, soft blur, and a 220ms rise. Reduced motion removes the rise.

## Shapes

Controls are 14px. The capsule and the prompt sheet are 20px on the outer corners. Groups are 16px. Icons are 1.75px stroke SVGs, one weight.

## Components

Ask is charcoal with phosphor type, full width, 52px. It stays that way when disabled, at 72% opacity. Secondary actions are white fields with a hairline, or rows inside an inset group. Place search is a field; the selected place is the capsule, not a second copy of the name. Post sort is a two-part segment. Choices in a prompt are full-width rows; the selected row becomes the capsule. The profile location readout uses phosphor inside the capsule.

## Do's and Don'ts

Do keep phosphor to the readout and Ask. Do keep simulated location labeled simulated. Do not return to the cream ground, the forest-green button, or a serif question. Do not turn posts into a card grid. Do not cover the sort control or the wordmark with the Dev toggle.
