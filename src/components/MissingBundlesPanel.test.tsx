import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  MissingBundlesPanel,
  parseMissingBundleIssues,
  parseMissingBundlesError,
} from "./MissingBundlesPanel";
import { AllProviders } from "../__test__/providers";
import { getInvokeCalls, registerInvokeHandler } from "../__test__/setup";
import type { Profile } from "../types";

describe("parseMissingBundlesError", () => {
  it("parses a multi-mod error with count and comma-separated names", () => {
    const msg =
      "Could not publish profile 'Moded actual': missing bundles for 5 mod(s): " +
      "a, b, c, d, e. Restore or reinstall these mods, then share again so the manifest can repair them later.";
    expect(parseMissingBundlesError(msg)).toEqual({
      count: 5,
      mods: ["a", "b", "c", "d", "e"],
    });
  });

  it("parses backend details when a publish failure includes the last upload error", () => {
    const msg =
      "Could not publish profile 'Solo Pack': missing bundles for 1 mod(s): Ascender's Sandbox. " +
      "Details: Ascender's Sandbox: Upload of 'Ascender_s_Sandbox_v1.1.1_7995e258.zip' failed with 422 already_exists. " +
      "Restore or reinstall these mods, then share again so the manifest can repair them later.";
    expect(parseMissingBundlesError(msg)).toEqual({
      count: 1,
      mods: ["Ascender's Sandbox"],
      details:
        "Ascender's Sandbox: Upload of 'Ascender_s_Sandbox_v1.1.1_7995e258.zip' failed with 422 already_exists",
    });
  });

  it("parses a single-mod error (mod(s) covers both singular and plural)", () => {
    const msg =
      "Could not publish profile 'X': missing bundles for 1 mod(s): SoloMod. Restore or reinstall these mods, then share again so the manifest can repair them later.";
    expect(parseMissingBundlesError(msg)).toEqual({
      count: 1,
      mods: ["SoloMod"],
    });
  });

  it("handles non-ASCII names and dotted names", () => {
    const msg =
      "Could not publish profile 'Moded actual': missing bundles for 5 mod(s): " +
      "尖塔铭者卡图强化, LimbusMusicMod.deps, SlayTheStats, Stats the Spire, StS2 Card Advisor. " +
      "Restore or reinstall these mods, then share again so the manifest can repair them later.";
    const parsed = parseMissingBundlesError(msg);
    expect(parsed).not.toBeNull();
    expect(parsed!.count).toBe(5);
    expect(parsed!.mods).toEqual([
      "尖塔铭者卡图强化",
      "LimbusMusicMod.deps",
      "SlayTheStats",
      "Stats the Spire",
      "StS2 Card Advisor",
    ]);
  });

  it("returns null for unrelated error strings", () => {
    expect(parseMissingBundlesError("network down")).toBeNull();
    expect(
      parseMissingBundlesError("GitHub API rate limit exceeded (60/hour)"),
    ).toBeNull();
    expect(
      parseMissingBundlesError("Could not publish profile 'X': token rejected"),
    ).toBeNull();
  });

  it("returns null on empty string", () => {
    expect(parseMissingBundlesError("")).toBeNull();
  });

  it("classifies mixed missing-local and upload details per mod", () => {
    expect(
      parseMissingBundleIssues(
        ["BrokenMod", "StuckMod"],
        "BrokenMod: [publish_issue:missing_unrecoverable] This mod is in the modpack but is not installed locally | StuckMod: [publish_issue:upload_failed] Upload failed with 422 already_exists",
      ),
    ).toEqual([
      {
        name: "BrokenMod",
        kind: "missing_unrecoverable",
        detail: "This mod is in the modpack but is not installed locally",
      },
      {
        name: "StuckMod",
        kind: "upload_failed",
        detail: "Upload failed with 422 already_exists",
      },
    ]);
  });

  it("dedupes stale same-mod missing and upload details in favor of retry", () => {
    const name = "RitsuLib (STS2 0.103.2 compat)";
    expect(
      parseMissingBundlesError(
        `Could not publish profile 'TesterW': missing bundles for 2 mod(s): ${name}, ${name}. Details: ${name}: [publish_issue:missing_unrecoverable] This mod is in the modpack but is not installed locally | ${name}: [publish_issue:upload_failed] Upload failed with 422 already_exists. Restore or reinstall these mods, then share again so the manifest can repair them later.`,
      ),
    ).toEqual({
      count: 1,
      mods: [name],
      details: `${name}: [publish_issue:missing_unrecoverable] This mod is in the modpack but is not installed locally | ${name}: [publish_issue:upload_failed] Upload failed with 422 already_exists`,
    });
    expect(
      parseMissingBundleIssues(
        [name],
        `${name}: [publish_issue:missing_unrecoverable] This mod is in the modpack but is not installed locally | ${name}: [publish_issue:upload_failed] Upload failed with 422 already_exists`,
      ),
    ).toEqual([
      {
        name,
        kind: "upload_failed",
        detail: "Upload failed with 422 already_exists",
      },
    ]);
  });
});

describe("<MissingBundlesPanel>", () => {
  const baseProfile: Profile = {
    id: "profile-1",
    name: "My Pack",
    game_version: null,
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    public: null,
    mods: [
      "A",
      "B",
      "C",
      "GoodMod",
      "BadMod",
      "BrokenMod",
      "StuckMod",
      "ModA",
      "ModB",
    ].map((name) => ({
      name,
      version: "1.0",
      source: `github:owner/${name.toLowerCase()}`,
      hash: null,
      files: [],
      enabled: true,
      bundle_url: null,
      folder_name: `${name}Folder`,
      mod_id: `${name}-id`,
    })),
    mod_extras: {},
  };

  function Wrap(
    props: Partial<React.ComponentProps<typeof MissingBundlesPanel>> = {},
  ) {
    return (
      <AllProviders>
        <MissingBundlesPanel
          profile={props.profile ?? baseProfile}
          modNames={props.modNames ?? ["ModA", "ModB"]}
          errorDetails={props.errorDetails}
          onRetryPublish={props.onRetryPublish ?? (async () => {})}
          onCancel={props.onCancel ?? (() => {})}
        />
      </AllProviders>
    );
  }

  it("renders local-missing guidance and one row per mod", () => {
    render(<Wrap modNames={["Alpha", "Beta", "Gamma"]} />);
    expect(
      screen.getByRole("heading", {
        name: /Some mods aren't installed locally/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/local files are missing/i)).toBeInTheDocument();
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getAllByText(/Pending/i)).toHaveLength(3);
  });

  it('upload failures keep "Try sharing again" as the recovery action', async () => {
    const onRetryPublish = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <Wrap
        modNames={["A", "B"]}
        errorDetails="A: Upload failed with 422 already_exists"
        onRetryPublish={onRetryPublish}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /Try sharing again/i }),
    );
    await waitFor(() => {
      expect(onRetryPublish).toHaveBeenCalledTimes(1);
    });
    expect(
      getInvokeCalls().filter(
        (c) => c.cmd === "restore_profile_mod_from_share",
      ),
    ).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: /Reinstall missing mods/i }),
    ).not.toBeInTheDocument();
  });

  it("mixed local and upload failures show both recovery actions and repair only local mods", async () => {
    registerInvokeHandler("restore_profile_mod_from_share", async (args) => ({
      name: String(args?.modName ?? ""),
      version: "1.0",
      enabled: true,
      files: [],
      source: null,
      hash: null,
      dependencies: [],
      size_bytes: 0,
    }));
    const onRetryPublish = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <Wrap
        modNames={["BrokenMod", "StuckMod"]}
        errorDetails="BrokenMod: [publish_issue:missing_unrecoverable] This mod is in the modpack but is not installed locally | StuckMod: [publish_issue:upload_failed] Upload failed with 422 already_exists"
        onRetryPublish={onRetryPublish}
      />,
    );

    expect(
      screen.getByText(
        /Some mods are missing locally and one upload also failed/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Try sharing again/i }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Reinstall missing mods/i }),
    );

    await waitFor(() => {
      const calls = getInvokeCalls().filter(
        (c) => c.cmd === "restore_profile_mod_from_share",
      );
      expect(calls.map((c) => c.args)).toEqual([
        {
          profileId: "profile-1",
          modName: "BrokenMod",
          folderName: "BrokenModFolder",
          modId: "BrokenMod-id",
        },
      ]);
    });
    expect(onRetryPublish).toHaveBeenCalledTimes(1);
  });

  it("local missing files offer remove and reinstall actions", () => {
    render(<Wrap modNames={["A"]} />);
    const removeBtn = screen.getByRole("button", {
      name: /Remove from modpack/i,
    });
    const reinstallBtn = screen.getByRole("button", {
      name: /Reinstall missing mods/i,
    });
    expect(removeBtn).toHaveClass("gf-btn-2");
    expect(reinstallBtn).toHaveClass("gf-btn");
    expect(
      screen.queryByRole("button", { name: /Try sharing again/i }),
    ).not.toBeInTheDocument();
  });

  it("surfaces local recovery guidance", () => {
    render(<Wrap modNames={["A"]} />);
    expect(
      screen.getByText(/Remove them from this modpack, or reinstall them/i),
    ).toBeInTheDocument();
  });

  it("shows the last backend error and hides local recovery for GitHub upload failures", () => {
    render(
      <Wrap
        modNames={["Ascender's Sandbox"]}
        errorDetails="Ascender's Sandbox: Upload failed with 422 already_exists"
      />,
    );
    expect(
      screen.getByRole("heading", { name: /Upload to GitHub didn't finish/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /GitHub returned an upload error after the app retried/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Repair will not help this case/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Last error:/i)).toHaveTextContent(
      "already_exists",
    );
    expect(
      screen.queryByRole("button", { name: /Reinstall missing mods/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Try sharing again/i }),
    ).toBeInTheDocument();
  });

  it('"Reinstall missing mods" restores every mod from the shared pack/source', async () => {
    registerInvokeHandler("restore_profile_mod_from_share", async (args) => ({
      name: String(args?.modName ?? ""),
      version: "1.0",
      enabled: true,
      files: [],
      source: null,
      hash: null,
      dependencies: [],
      size_bytes: 0,
    }));
    const onRetryPublish = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Wrap modNames={["A", "B", "C"]} onRetryPublish={onRetryPublish} />);
    await user.click(
      screen.getByRole("button", { name: /Reinstall missing mods/i }),
    );
    await waitFor(() => {
      const calls = getInvokeCalls().filter(
        (c) => c.cmd === "restore_profile_mod_from_share",
      );
      expect(calls.map((c) => c.args)).toEqual([
        {
          profileId: "profile-1",
          modName: "A",
          folderName: "AFolder",
          modId: "A-id",
        },
        {
          profileId: "profile-1",
          modName: "B",
          folderName: "BFolder",
          modId: "B-id",
        },
        {
          profileId: "profile-1",
          modName: "C",
          folderName: "CFolder",
          modId: "C-id",
        },
      ]);
    });
  });

  it("marks each mod Repaired after reinstall success and auto-retries the publish", async () => {
    registerInvokeHandler("restore_profile_mod_from_share", async () => ({
      name: "irrelevant",
      version: "1.0",
      enabled: true,
      files: [],
      source: null,
      hash: null,
      dependencies: [],
      size_bytes: 0,
    }));
    const onRetryPublish = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Wrap modNames={["A", "B"]} onRetryPublish={onRetryPublish} />);
    await user.click(
      screen.getByRole("button", { name: /Reinstall missing mods/i }),
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Repaired/i).length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(onRetryPublish).toHaveBeenCalledTimes(1);
    });
  });

  it("marks a row Failed when reinstall rejects and shows the Open mod folder fallback", async () => {
    registerInvokeHandler("restore_profile_mod_from_share", (args) => {
      if (args?.modName === "BadMod") {
        throw new Error("checksum mismatch");
      }
      return {
        name: String(args?.modName ?? ""),
        version: "1.0",
        enabled: true,
        files: [],
        source: null,
        hash: null,
        dependencies: [],
        size_bytes: 0,
      };
    });
    const onRetryPublish = vi.fn();
    const user = userEvent.setup();
    render(
      <Wrap modNames={["GoodMod", "BadMod"]} onRetryPublish={onRetryPublish} />,
    );
    await user.click(
      screen.getByRole("button", { name: /Reinstall missing mods/i }),
    );
    await waitFor(() => {
      expect(screen.getByText(/Failed/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Repaired/i)).toBeInTheDocument();
    expect(onRetryPublish).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Open mod folder/i }),
    ).toBeInTheDocument();
  });

  it('clicking "Open mod folder" invokes open_mods_folder', async () => {
    registerInvokeHandler("restore_profile_mod_from_share", () => {
      throw new Error("locked file");
    });
    registerInvokeHandler("open_mods_folder", () => true);
    const user = userEvent.setup();
    render(<Wrap modNames={["BrokenMod"]} />);
    await user.click(
      screen.getByRole("button", { name: /Reinstall missing mods/i }),
    );
    await waitFor(() => {
      expect(screen.getByText(/Failed/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Open mod folder/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === "open_mods_folder")).toBe(
        true,
      );
    });
  });

  it("retrying after partial failure only re-attempts the failed mods", async () => {
    let badAttempts = 0;
    registerInvokeHandler("restore_profile_mod_from_share", (args) => {
      if (args?.modName === "BadMod") {
        badAttempts++;
        if (badAttempts === 1) throw new Error("try again");
      }
      return {
        name: String(args?.modName ?? ""),
        version: "1.0",
        enabled: true,
        files: [],
        source: null,
        hash: null,
        dependencies: [],
        size_bytes: 0,
      };
    });
    const onRetryPublish = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <Wrap modNames={["GoodMod", "BadMod"]} onRetryPublish={onRetryPublish} />,
    );
    const reinstallBtn = screen.getByRole("button", {
      name: /Reinstall missing mods/i,
    });
    await user.click(reinstallBtn);
    await waitFor(() => {
      expect(screen.getByText(/Failed/i)).toBeInTheDocument();
    });
    expect(
      getInvokeCalls().filter(
        (c) => c.cmd === "restore_profile_mod_from_share",
      ),
    ).toHaveLength(2);
    await user.click(reinstallBtn);
    await waitFor(() => {
      expect(badAttempts).toBe(2);
      expect(
        getInvokeCalls().filter(
          (c) => c.cmd === "restore_profile_mod_from_share",
        ),
      ).toHaveLength(3);
    });
    await waitFor(() => {
      expect(onRetryPublish).toHaveBeenCalledTimes(1);
    });
  });

  it('"Remove from modpack" removes every stale row and auto-retries the publish', async () => {
    registerInvokeHandler("set_profile_mod_membership", () => baseProfile);
    const onRetryPublish = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Wrap modNames={["A", "B"]} onRetryPublish={onRetryPublish} />);
    await user.click(
      screen.getByRole("button", { name: /Remove from modpack/i }),
    );
    await waitFor(() => {
      const calls = getInvokeCalls().filter(
        (c) => c.cmd === "set_profile_mod_membership",
      );
      expect(calls.map((c) => c.args)).toEqual([
        {
          profileId: "profile-1",
          modName: "A",
          modVersionId: null,
          folderName: "AFolder",
          modId: "A-id",
          included: false,
          sourceHint: "github:owner/a",
        },
        {
          profileId: "profile-1",
          modName: "B",
          modVersionId: null,
          folderName: "BFolder",
          modId: "B-id",
          included: false,
          sourceHint: "github:owner/b",
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.getAllByText(/Removed/i).length).toBeGreaterThanOrEqual(2);
      expect(onRetryPublish).toHaveBeenCalledTimes(1);
    });
  });

  it("partial remove failure keeps the panel open without auto-retry", async () => {
    registerInvokeHandler("set_profile_mod_membership", (args) => {
      if (args?.modName === "BadMod") throw new Error("still locked");
      return baseProfile;
    });
    const onRetryPublish = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <Wrap modNames={["GoodMod", "BadMod"]} onRetryPublish={onRetryPublish} />,
    );
    await user.click(
      screen.getByRole("button", { name: /Remove from modpack/i }),
    );
    await waitFor(() => {
      expect(screen.getByText(/Failed/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Removed/i)).toBeInTheDocument();
    expect(onRetryPublish).not.toHaveBeenCalled();
  });

  it("Cancel button calls onCancel", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("reinstall button is disabled while a reinstall pass is in flight", async () => {
    registerInvokeHandler(
      "restore_profile_mod_from_share",
      () => new Promise(() => {}),
    );
    const user = userEvent.setup();
    render(<Wrap modNames={["StuckMod"]} />);
    const reinstallBtn = screen.getByRole("button", {
      name: /Reinstall missing mods/i,
    });
    await user.click(reinstallBtn);
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /Fixing/i })[0],
      ).toBeDisabled();
    });
  });
});
