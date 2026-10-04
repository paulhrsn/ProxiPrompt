---
name: ProxiPrompt
description: A phone for asking what a place is like right now.
colors:
  bone: "#F7F6F3"
  sheet: "#FFFFFF"
  ink: "#2F3437"
  black: "#111111"
  muted: "#787774"
  line: "#EAEAEA"
  field-line: "#DEDCD6"
  high: "#346538"
  high-wash: "#EDF3EC"
  medium: "#956400"
  medium-wash: "#FBF3DB"
  low: "#9F2F2D"
  low-wash: "#FDEBEC"
typography:
  body:
    fontFamily: "SF Pro Display, Helvetica Neue, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  title:
    fontFamily: "Iowan Old Style, Palatino, Georgia, serif"
    fontSize: "32px"
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: "-0.03em"
  label:
    fontFamily: "SF Pro Display, Helvetica Neue, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
rounded:
  button: "6px"
  field: "8px"
  card: "12px"
spacing:
  screen-x: "20px"
  stack: "16px"
  control-height: "48px"
  tap: "44px"
components:
  button-primary:
    backgroundColor: "{colors.black}"
    textColor: "#FFFFFF"
    rounded: "{rounded.button}"
    padding: "0 18px"
    height: "48px"
    width: "100%"
  button-primary-hover:
    backgroundColor: "#333333"
    textColor: "#FFFFFF"
  button-secondary:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
  field:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    height: "48px"
    padding: "12px 14px"
  status-card:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "22px 18px 18px"
  tab-bar:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.muted}"
    height: "56px"
---

## Overview

ProxiPrompt is a phone-width app on a warm bone ground. Titles are serif. Everything you can change is a white field with a hairline border. Ask is a black button. Three tabs sit on the thumb: Ask, Posts, and You. A prompt arrives as a sheet over the current screen.

## Colors

Bone is the page. White is every field, card, and sheet. Rules are #EAEAEA. Type is off-black, never pure black for body copy. The only solid dark fill is the primary button and a selected chip or segment. High, Medium, and Low use the pale green, yellow, and red washes.

## Typography

Titles and the location readout use Iowan Old Style, Palatino, or Georgia. Controls, labels, and body use SF Pro Display or Helvetica Neue. Diagnostics use SF Mono. Do not load Inter, Roboto, or Open Sans.

## Layout

The column is 430px, centered, with 20px side padding and safe-area insets. Root screens keep the tab bar. The Ask control sits at the bottom of a short ask screen. Do not add a second navigation row.

## Elevation & Depth

Flat. The prompt sheet is the one shadow: `0 -2px 8px rgba(0,0,0,0.04)`. No gradients and no glow.

## Shapes

Buttons are 6px. Fields and option chips are 8px. Cards, the status block, and groups are 12px. Confidence badges are the only pills.

## Components

Every text input, textarea, and select is white with a 1px #DEDCD6 border. A value you can switch — anonymous or your name, a place on a post, comment count — uses the same bordered control, not plain text. The profile name is a bordered field; tapping it edits. Selected radios and place chips use a black edge or a black fill. Disabled primary buttons drop to a white field with muted type.

## Do's and Don'ts

Do keep simulated location labeled simulated. Do not fill a large region with a bright color. Do not use phosphor, a dark status capsule, or a forest-green button. Do not cover the sort control with the Dev toggle.
