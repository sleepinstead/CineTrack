# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary user:** one person tracking the films and TV they watch, on their own machine. They keep a personal library, log episodes and rewatches, and look back on their viewing.
- **Landing page audience (confirmed):** portfolio viewers evaluating the maker's craft. They are not expected to install anything; they judge the product's thinking, polish and coherence.

## Product Purpose

CineTrack is a personal, local film and TV tracker: a quiet "cinema ledger" rather than a social feed. Success is a library that is pleasant to keep up to date and rewarding to look back on.

## Positioning

A single-user tracker that treats TV properly (episode-level logging, seasons, separately tracked rewatches) and stays entirely on the user's own machine. There are no accounts, feeds or social features.

## Operating Context

- Runs as a local web app (React + Vite) with a local API. The library is stored in a SQLite file in the project folder.
- Title data and artwork come from The Movie Database (TMDb) through a local proxy; TMDb attribution is required ("This product uses the TMDb API but is not endorsed or certified by TMDb").
- Main areas: Home (greeting, stats, in-progress titles, activity, Feeling lucky picks, monthly log), Discover (Trending, For You, Films, TV Shows, search), Library (filters, sort, search), title drawer (status, rating, dates, notes, custom posters, episodes, cast), Settings.

## Capabilities and Constraints

- Status: Planned, Watching, Watched, Dropped; ratings, favourites, notes, watch dates, custom posters.
- TV: tick single episodes or whole seasons; rewatches tracked separately; specials optional; series can be marked Watched automatically.
- Discovery: TMDb search, trending, Films/TV browse with sort and genre, "For You" sections seeded from the library.
- History: monthly log of completions, hours watched, title counts, activity ledger.
- Portability: full JSON backup and restore (library and preferences); erase with undo.
- Themes: light (Paper) and dark (Noir), plus follow-system.
- Landing page lead points (confirmed): proper TV tracking, discovery, viewing history. Local-first privacy is true but not a lead point for this page.

## Brand Commitments

- Name: CineTrack. Logo mark: two overlapping circles, pink `#D93D87` and blue `#263C92`.
- Existing voice: calm, archival and precise ("cinema ledger"; small uppercase labels; italic serif headings).

## Evidence on Hand

- Real product UI (the app itself) and TMDb artwork via the proxy.
- No testimonials, user counts, press, pricing or download statistics exist. Do not fabricate any.
- Landing page content is neutral product content (confirmed); it does not show the owner's personal library.

## Product Principles

1. Quiet over busy: the interface recedes so films and shows lead.
2. Precise tracking without friction: logging an episode or a rewatch should take one action.
3. Honest content: show the real product and real artwork; never invent proof.
4. One coherent language across every surface, light and dark.

## Accessibility & Inclusion

Text pairs meet WCAG AA in both themes (enforced by tests, with documented exceptions for the accent). Keyboard operation and screen-reader labels are maintained across the app; reduced motion is respected.
