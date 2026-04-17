# ◇ Lattice

A self-hosted AI/ML news aggregator that pulls from RSS feeds across labs, blogs, research, and community sources. Built for Docker deployment with Homepage and Home Assistant integration.

![Dashboard](https://img.shields.io/badge/stack-Node.js%20%2B%20Express-green) ![Docker](https://img.shields.io/badge/docker-ready-blue)

## Quick Start

```bash
docker compose up -d
```

Dashboard available at `http://your-server:3200`

## Features

- **17 curated AI/ML feeds** — Anthropic, OpenAI, Google, Meta, Hacker News, arXiv, Simon Willison, and more
- **Category filtering** — Labs, News, Research, Community, Blogs, Newsletters
- **Full-text search** across titles, summaries, and sources
- **Auto-refresh** with configurable cache TTL
- **Hot-reload feeds** — edit `feeds.json` and changes apply automatically (no restart needed)
- **Embeddable mode** — append `?embed` for a compact iframe-friendly view
- **Health check endpoint** for monitoring
- **Catppuccin Mocha theme** — dark, clean, at home on any dashboard

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Dashboard UI |
| `GET /?embed` | Compact embeddable view |
| `GET /api/feed` | All articles (supports `?category=`, `?source=`, `?search=`, `?limit=`, `?offset=`) |
| `GET /api/sources` | Feed sources grouped by category |
| `GET /api/stats` | Feed stats (counts, errors, categories) |
| `GET /api/health` | Health check |
| `GET /api/homepage` | Homepage-widget-compatible format (latest 5 items) |

## Homepage Integration

Add to your Homepage `services.yaml`:

```yaml
- AI:
    - Lattice:
        icon: mdi-newspaper-variant-outline
        href: http://your-server:3200
        description: AI/ML News Aggregator
        widget:
          type: customapi
          url: http://lattice:3000/api/stats
          mappings:
            - field: itemCount
              label: Articles
            - field: feedCount
              label: Sources
            - field:
                errors: length
              label: Errors
```

Or use the iframe widget for a live feed:

```yaml
- AI:
    - Lattice Feed:
        widget:
          type: iframe
          src: http://your-server:3200/?embed
          height: 400
```

## Home Assistant Integration

### Option 1: Iframe Card (simplest)

```yaml
type: iframe
url: http://your-server:3200/?embed
aspect_ratio: 16:9
```

### Option 2: REST Sensor + Markdown Card

In `configuration.yaml`:

```yaml
rest:
  - resource: http://your-server:3200/api/homepage
    scan_interval: 900
    sensor:
      - name: "Lattice Feed"
        value_template: "{{ value_json | length }} articles"
        json_attributes:
          - "[0]"
          - "[1]"
          - "[2]"
          - "[3]"
          - "[4]"

sensor:
  - platform: rest
    resource: http://your-server:3200/api/stats
    name: "Lattice Stats"
    value_template: "{{ value_json.itemCount }}"
    json_attributes:
      - feedCount
      - lastUpdated
      - errors
    scan_interval: 900
```

### Option 3: Mushroom + card-mod

```yaml
type: custom:mushroom-template-card
primary: Lattice
secondary: >-
  {{ states('sensor.lattice_stats') }} articles from
  {{ state_attr('sensor.lattice_stats', 'feedCount') }} sources
icon: mdi:newspaper-variant-outline
icon_color: blue
tap_action:
  action: url
  url_path: http://your-server:3200
card_mod:
  style: |
    ha-card {
      background: var(--card-background-color);
    }
```

## Customizing Feeds

Edit `feeds.json` — changes are detected automatically:

```json
[
  {
    "url": "https://example.com/feed.xml",
    "category": "Custom",
    "name": "My Feed",
    "icon": "⭐"
  }
]
```

Categories can be anything — the dashboard generates filter pills dynamically.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `CACHE_TTL` | `900` | Feed cache TTL in seconds |
| `FEEDS_FILE` | `./feeds.json` | Path to feeds config |

## Network Notes

Some feeds (Reddit, HN) may rate-limit. Lattice caches aggressively and uses a polite User-Agent. If you're behind a reverse proxy (Traefik, Caddy, nginx), just proxy to port 3200 as usual.
