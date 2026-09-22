# LAN companion search

The companion app is a development-time web search interface for Substream. It makes it practical to search a provider's full Xtream catalogue from a phone or computer, then opens the chosen title's details page on the paired TV.

It is intended for a trusted home LAN. It is not an internet-facing service or a replacement for a production backend.

## What it does

- The local companion service queries and indexes the full Xtream movie and series catalogue.
- The phone/computer browser receives only title metadata and provider identifiers. It never receives provider credentials or playable stream URLs.
- The TV receives a selected provider identifier and derives the final stream URL from its own locally saved provider connection.
- The companion browser stores the safe catalogue in IndexedDB. It can continue to search its most recently saved catalogue after the local service goes down.
- While a pairing session remains live, the TV accepts selections even if the viewer has left Settings, is browsing, has a dialog open, or is playing another title. The selected title replaces the current view with its details page.

The service is currently limited to Xtream-compatible `get.php` playlist URLs. M3U-only playlists are not supported by companion search.

## Requirements

- The TV, the companion device, and the computer running the service must be on the same non-guest LAN.
- The computer must accept connections on port `8787` by default. The service listens on every LAN interface (`0.0.0.0`).
- The TV playlist must be an Xtream `get.php` URL.

Guest Wi-Fi, client isolation, a firewall, or an incorrect LAN address can prevent pairing.

## Setup

1. In the repository root, copy `.env.example` to the ignored `.env` file if you do not already have one.
2. Set the computer's reachable LAN address. This address is not a secret and is embedded into the TV build:

   ```sh
   COMPANION_SERVER_URL=http://192.168.1.50:8787
   ```

3. Rebuild and deploy the TV application after changing `COMPANION_SERVER_URL`.
4. Start the companion service on the computer:

   ```sh
   npm run companion:dev
   ```

5. On the TV, open **Settings → Companion search**. With the configured default, move focus to **Start pairing** and press Action/Enter. To change the address, focus it and press Action/Enter to deliberately enter text editing; arrows leave text editing and resume Settings navigation.

6. The TV displays a companion address and six-digit pairing code. Open that address on the phone or computer, enter the code, and wait for the catalogue to finish saving.

## Searching and selecting

The companion saves the fetched catalogue to the browser's IndexedDB immediately after pairing. Enter at least two characters and press **Search**. Selecting a result sends its provider ID through the local service to the TV, which opens its details page.

Use **Refresh catalogue** to retrieve a current catalogue from the provider and replace the browser cache. A full provider refresh can take a while for large catalogues.

If the companion service becomes unavailable after a successful fetch, the companion searches its latest saved catalogue and displays an offline-cache status. It cannot send a selected result until both the local service and paired TV are reachable again. Pairing sessions expire after 30 minutes; pair again to create a new relay session.

## Data and security boundaries

| Location | Data held |
| --- | --- |
| TV app | Playlist URL/provider credentials and final stream URLs |
| Local companion service memory | Xtream connection credentials and full provider records, for the active 30-minute session only |
| Companion browser IndexedDB | Safe title metadata, content type, provider IDs, source fingerprint, and catalogue timestamp |

The local service deliberately never returns credentials or stream URLs to the companion browser. Do not expose it beyond a trusted LAN: it uses plain HTTP for development and accepts the pairing code as the session gate. A public deployment needs HTTPS/WSS, durable secure session storage, authentication/rate limiting, and encrypted provider credential storage.

## Troubleshooting

- **The TV cannot start pairing:** verify `npm run companion:dev` is running, the address starts with `http://`, and the TV can reach the computer's LAN IP. Rebuild/redeploy after changing `.env`.
- **The phone cannot open the companion address:** do not use `localhost`; use the computer's LAN IP. Check that the phone is not on a guest Wi-Fi network and that the computer firewall permits port 8787.
- **Pairing says only Xtream URLs are supported:** companion search currently requires a `get.php` provider URL. Continue browsing on the TV for an M3U-only source.
- **Saved search works but selection fails:** restart `npm run companion:dev` if needed, confirm the TV app remains open, and pair again if the 30-minute session expired.
- **Results appear stale:** press **Refresh catalogue** while the local service is available.

