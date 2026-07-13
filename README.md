# Brew

A beautiful Electron app that keeps your MacBook awake - styled like a fresh cup of coffee.

## Features

- **Manual ON/OFF buttons** - "BREW ON" to keep awake, "BREW OFF" to allow sleep
- **Coffee color theme** - When ON, the entire app transforms into warm coffee/amber tones
- **Rich animations** including:
  - Floating coffee beans
  - Rising steam particles
  - Glowing app icon with breathing effect
  - Pulsing status rings
  - Shimmer effect on timer bar
  - Button hover/press ripple effects
  - Smooth entrance transitions
  - Border glow around the window
- **System tray** - Runs in the menu bar for quick access
- **Uptime timer** - See how long your Mac has been kept awake
- **Custom app icon** - Beautiful 3D coffee cup icon

## How It Works

Uses macOS's native `caffeinate` command:
- `-d` Prevent display sleep
- `-i` Prevent idle sleep
- `-s` Prevent system sleep (on AC power)
- `-u` Declare user activity

## Run

```bash
cd brew
npm start
```

## Build

```bash
npm run build
```
