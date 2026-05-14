# Mod load order — research notes (icebox)

Status: **iceboxed**. See [#34](https://github.com/MohamedSerhan/sts2-mod-manager/issues/34) for the original feedback.

## TL;DR

We spent a research pass understanding what it would actually take to manage mod load order from inside our Tauri app. The cleanest path requires either reverse-engineering STS2's save-file format end-to-end **or** building and maintaining a companion in-game .NET mod. Both are substantial multi-week efforts with ongoing maintenance burden tracking game updates. Recommending an existing in-game tool to users is a much smaller intervention that gets them the feature now. We're parking the native-UX path until either (a) the demand justifies the investment, or (b) the game ships a more accessible API.

## What we found

### Where the load order actually lives

STS2's mod load order is stored inside its `settings.save` file under Godot's user-data directory. The path is segmented by **platform** and **player ID**:

```
<godot_user_data>/{steam|gog|epic|xbox|none}/<numeric_user_id>/settings.save
```

A regex-extractable platform + numeric ID is part of the path. Multi-account safety: tools that write this file must verify the runtime user matches the path's user, or risk overwriting the wrong account's settings.

### How the game models it

The relevant runtime object graph (from inspecting the published modding surface STS2 exposes):

- `MegaCrit.Sts2.Core.Saves.SaveManager` — singleton, holds `SettingsSave`
- `SaveManager.SettingsSave.ModSettings.ModList` — `List<SettingsSaveMod>`
- Each `SettingsSaveMod`:
  - `Id: string` — the mod's manifest `id`
  - `Source: ModSource` — enum: `1` = mod from `mods/` folder, `2` = Steam Workshop, others = unknown
  - `IsEnabled: bool`

The position of an entry in `ModList` **is** the load order. Top of list = loaded first.

### How the game persists it

`SaveManager.SaveSettings()` (no args) writes the entire `SettingsSave` graph to disk. The serialization is opaque from outside — handled by Godot's own SaveStore in the game's main assembly. It's not a plain `ConfigFile` (`[section]\nkey=value`) text file; it goes through the game's serializer. **No public spec, no documented format.**

This is why every in-game mod that manages load order uses the same approach: take a reference to `SaveManager.Instance`, mutate `ModList` via reflection, and let the game itself save. They don't write the file directly.

## Why writing `settings.save` ourselves is not a small project

To do this from outside the game we would need to:

1. **Reverse-engineer the save format end-to-end.** STS2's main game assembly is far larger than any mod's. The save format isn't text — it's whatever the game's `SaveStore` chose. Parser + writer would be non-trivial and we'd own its correctness.
2. **Survive game updates.** Save format can change between game versions. We'd need a compatibility matrix and an "unsupported save version" failure mode. Real maintenance burden.
3. **Replicate the multi-account safety check.** Resolve the runtime user ID, verify against the path's ID, refuse cross-account writes. Doable but adds surface area.
4. **Handle conflicts with in-game sorter mods.** Some dependency-sorter mods rewrite the mod list at launch. Whatever order we write can be silently re-sorted before the game finishes loading. Hard to fully solve from outside the game process.

Realistic estimate: 2-6 weeks of focused work for an MVP, plus ongoing maintenance pegged to game updates.

## Why a companion .NET mod is not a small project either

We could build a tiny .NET / Godot Mono mod that:

- Reads an intent JSON file our manager writes (e.g. `<config>/sts2mm-load-order.json`)
- Applies it via reflection on `SaveManager.Instance.SettingsSave.ModSettings.ModList`
- Calls `SaveManager.SaveSettings()`
- Exits

This sidesteps the save-format question entirely (the game does the writing) but introduces:

- A new codebase (.NET, not Rust) we'd ship alongside the manager
- A second build pipeline + release cadence
- Harmony / BepInEx-style patching to hook into game lifecycle
- All the same compatibility-with-game-updates risk
- Distribution: do we auto-install it? Bundle it? Document it as a prereq? Each option has UX implications.

Closer to 1-2 months for a polished v1, plus ongoing maintenance.

## Recommended path when this comes off ice

When this feature comes back from icebox, the highest-leverage move is:

1. **Detect** at audit time when the user has two or more mods that ship `.pck` files (the case where load order most often matters — overlapping card art / character skins / scene replacements).
2. **Recommend** an existing in-game load-order tool with a non-blocking banner: "Want to control which of these wins? Install <tool>."
3. **One-click install** the recommended tool via our existing Quick Add flow.
4. **Document the workflow** in our README.

That ships in roughly a week, has no ongoing maintenance burden, and leverages an existing well-tested implementation rather than writing our own.

If demand later justifies fully native UX, the companion-mod path (#2 above) is the better long-term investment over reverse-engineering the save format — the game does the writing, so we never own its compatibility surface.

## What's intentionally out of scope of this doc

- Specific Nexus mod IDs or links — pin those at implementation time, since the recommended tool may change.
- UI mockups — design when the feature actually moves to implementation, not now.
- Detection details for `.pck` overlap — the simple "≥2 pck-bearing mods installed" heuristic is the MVP; smarter overlap detection (parsing Godot pck table-of-contents) is a separate research thread.

## Closing the loop

Filed back on issue #34 so future-us can pick it up with the research already done.
