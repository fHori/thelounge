---
layout: home

hero:
  name: Horizon Lounge
  text: Self-hosted web IRC client
  tagline: Fork of the popular client with tracker focused tweaks, better performance and a focus on expandability.
  image:
    src: /logo.svg
    alt: Horizon Lounge
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Migrating
      link: /migrating
    - theme: alt
      text: Settings
      link: /settings/server

features:
  - title: Full-history FTS search
    details: Fast SQLite full-text search across your entire channel history, with instant jump to any result or mention.
  - title: Worker-thread SQLite storage
    details: Long histories load quickly, scroll back without limit, and run SQLite on its own worker thread so slow disks cannot freeze the server.
  - title: Tracker profiles & shoutbox bridges
    details: Right-click any user on a configured tracker network to open their profile, with bridged shoutbox bots rewritten to show the real sender.
  - title: Upload backends & local expiry
    details: Upload straight to Catbox, Zipline, rustypaste, and others, or host locally with configurable 1-7 day auto-deletion.
  - title: Collapsible netsplits & DM pinning
    details: Rapid join/quit storms collapse into a single summary line, and direct messages get their own pinnable sidebar section.
  - title: Hardened defaults
    details: Authenticated file uploads, safer server and browser input handling, and a rootless-friendly Docker image running as UID 1000.
---
