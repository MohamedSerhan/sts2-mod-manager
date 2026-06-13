import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  MissingBundlesPanel,
  parseMissingBundlesError,
} from './MissingBundlesPanel';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

describe('parseMissingBundlesError', () => {
  it('parses a multi-mod error with count and comma-separated names', () => {
    const msg =
      "Could not publish profile 'Moded actual': missing bundles for 5 mod(s): " +
      'a, b, c, d, e. Restore or reinstall these mods, then share again so the manifest can repair them later.';
    expect(parseMissingBundlesError(msg)).toEqual({
      count: 5,
      mods: ['a', 'b', 'c', 'd', 'e'],
    });
  });

  it('parses backend details when a publish failure includes the last upload error', () => {
    const msg =
      "Could not publish profile 'Solo Pack': missing bundles for 1 mod(s): Ascender's Sandbox. " +
      "Details: Ascender's Sandbox: Upload of 'Ascender_s_Sandbox_v1.1.1_7995e258.zip' failed with 422 already_exists. " +
      'Restore or reinstall these mods, then share again so the manifest can repair them later.';
    expect(parseMissingBundlesError(msg)).toEqual({
      count: 1,
      mods: ["Ascender's Sandbox"],
      details:
        "Ascender's Sandbox: Upload of 'Ascender_s_Sandbox_v1.1.1_7995e258.zip' failed with 422 already_exists",
    });
  });

  it('parses a single-mod error (mod(s) covers both singular and plural)', () => {
    const msg =
      "Could not publish profile 'X': missing bundles for 1 mod(s): SoloMod. Restore or reinstall these mods, then share again so the manifest can repair them later.";
    expect(parseMissingBundlesError(msg)).toEqual({
      count: 1,
      mods: ['SoloMod'],
    });
  });

  it('handles the original Solo bug report verbatim (Chinese + dotted names)', () => {
    // Mod names mix Chinese characters, dots, and spaces — the parser must
    // not choke on those. The list separator is ", " between names, and the
    // outer terminator is ". Restore".
    const msg =
      "Could not publish profile 'Moded actual': missing bundles for 5 mod(s): " +
      '尖塔铭者卡图强化, LimbusMusicMod.deps, SlayTheStats, Stats the Spire, StS2 Card Advisor. ' +
      'Restore or reinstall these mods, then share again so the manifest can repair them later.';
    const parsed = parseMissingBundlesError(msg);
    expect(parsed).not.toBeNull();
    expect(parsed!.count).toBe(5);
    expect(parsed!.mods).toEqual([
      '尖塔铭者卡图强化',
      'LimbusMusicMod.deps',
      'SlayTheStats',
      'Stats the Spire',
      'StS2 Card Advisor',
    ]);
  });

  it('returns null for unrelated error strings', () => {
    expect(parseMissingBundlesError('network down')).toBeNull();
    expect(
      parseMissingBundlesError('GitHub API rate limit exceeded (60/hour)'),
    ).toBeNull();
    expect(
      parseMissingBundlesError("Could not publish profile 'X': token rejected"),
    ).toBeNull();
  });

  it('returns null on empty string', () => {
    expect(parseMissingBundlesError('')).toBeNull();
  });
});

describe('<MissingBundlesPanel>', () => {
  function Wrap(
    props: Partial<React.ComponentProps<typeof MissingBundlesPanel>> = {},
  ) {
    return (
      <AllProviders>
        <MissingBundlesPanel
          modNames={props.modNames ?? ['ModA', 'ModB']}
          errorDetails={props.errorDetails}
          onRetryPublish={props.onRetryPublish ?? (async () => {})}
          onCancel={props.onCancel ?? (() => {})}
        />
      </AllProviders>
    );
  }

  it('renders the heading, explanation, and one row per mod', () => {
    render(<Wrap modNames={['Alpha', 'Beta', 'Gamma']} />);
    expect(
      screen.getByRole('heading', {
        name: /Some mod uploads didn't finish/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/couldn't finish uploading bundles/i),
    ).toBeInTheDocument();
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    // Every row starts with "Pending" status.
    const pending = screen.getAllByText(/Pending/i);
    expect(pending.length).toBe(3);
  });

  it('primary "Try sharing again" button re-runs the share (issue #164)', async () => {
    // The common cause is a transient upload failure, so the panel leads
    // with re-sharing rather than repairing. Clicking it must call
    // onRetryPublish directly — without invoking repair_mod at all.
    const onRetryPublish = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Wrap modNames={['A', 'B']} onRetryPublish={onRetryPublish} />);
    await user.click(
      screen.getByRole('button', { name: /Try sharing again/i }),
    );
    await waitFor(() => {
      expect(onRetryPublish).toHaveBeenCalledTimes(1);
    });
    // No repair was attempted — re-sharing is the upload-failure remedy.
    expect(
      getInvokeCalls().filter((c) => c.cmd === 'repair_mod').length,
    ).toBe(0);
  });

  it('"Try sharing again" is the primary action and "Repair these mods" the secondary', () => {
    render(<Wrap modNames={['A']} />);
    const shareBtn = screen.getByRole('button', {
      name: /Try sharing again/i,
    });
    const repairBtn = screen.getByRole('button', {
      name: /Repair these mods/i,
    });
    // Primary carries the prominent button class; secondary the muted one.
    expect(shareBtn).toHaveClass('gf-btn');
    expect(repairBtn).toHaveClass('gf-btn-2');
  });

  it('surfaces the repair guidance that repair is only for local files', () => {
    render(<Wrap modNames={['A']} />);
    expect(
      screen.getByText(/Repair only helps when local files are missing or broken/i),
    ).toBeInTheDocument();
  });

  it('shows the last backend error and hides repair for GitHub upload failures', () => {
    render(
      <Wrap
        modNames={["Ascender's Sandbox"]}
        errorDetails="Ascender's Sandbox: Upload failed with 422 already_exists"
      />,
    );
    expect(
      screen.getByRole('heading', { name: /Upload to GitHub didn't finish/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/GitHub returned an upload error after the app retried/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Repair will not help this case/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Last error:/i)).toHaveTextContent('already_exists');
    expect(
      screen.queryByRole('button', { name: /Repair these mods/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Try sharing again/i }),
    ).toBeInTheDocument();
  });

  it('"Repair these mods" calls repair_mod sequentially for every mod', async () => {
    registerInvokeHandler('repair_mod', async (args) => {
      // Echo back a fake ModInfo — the panel ignores the value.
      return {
        name: String(args?.name ?? ''),
        version: '1.0',
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
      <Wrap modNames={['A', 'B', 'C']} onRetryPublish={onRetryPublish} />,
    );
    await user.click(screen.getByRole('button', { name: /Repair these mods/i }));
    await waitFor(() => {
      const repairCalls = getInvokeCalls().filter((c) => c.cmd === 'repair_mod');
      expect(repairCalls.length).toBe(3);
      expect(repairCalls.map((c) => c.args)).toEqual([
        { name: 'A', folderName: null },
        { name: 'B', folderName: null },
        { name: 'C', folderName: null },
      ]);
    });
  });

  it('marks each mod ✓ Repaired after success and auto-retries the publish', async () => {
    registerInvokeHandler('repair_mod', async () => ({
      name: 'irrelevant',
      version: '1.0',
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
      <Wrap modNames={['A', 'B']} onRetryPublish={onRetryPublish} />,
    );
    await user.click(screen.getByRole('button', { name: /Repair these mods/i }));
    await waitFor(() => {
      expect(screen.getAllByText(/Repaired/i).length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(onRetryPublish).toHaveBeenCalledTimes(1);
    });
  });

  it('marks a row ✗ Failed when repair_mod rejects and shows the Open mod folder fallback', async () => {
    registerInvokeHandler('repair_mod', (args) => {
      if (args?.name === 'BadMod') {
        throw new Error('checksum mismatch');
      }
      return {
        name: String(args?.name ?? ''),
        version: '1.0',
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
      <Wrap
        modNames={['GoodMod', 'BadMod']}
        onRetryPublish={onRetryPublish}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Repair these mods/i }));
    // Wait for BadMod to land in failed state.
    await waitFor(() => {
      expect(screen.getByText(/Failed/i)).toBeInTheDocument();
    });
    // GoodMod is ✓ Repaired in the same panel.
    expect(screen.getByText(/Repaired/i)).toBeInTheDocument();
    // Partial failure: auto-retry must NOT fire because not all repairs
    // succeeded — that would just produce the same missing-bundles error.
    expect(onRetryPublish).not.toHaveBeenCalled();
    // Recovery link: "Open mod folder" surfaces for the failed mod.
    expect(
      screen.getByRole('button', { name: /Open mod folder/i }),
    ).toBeInTheDocument();
  });

  it('clicking "Open mod folder" invokes open_mods_folder', async () => {
    registerInvokeHandler('repair_mod', () => {
      throw new Error('locked file');
    });
    registerInvokeHandler('open_mods_folder', () => true);
    const user = userEvent.setup();
    render(<Wrap modNames={['BrokenMod']} />);
    await user.click(screen.getByRole('button', { name: /Repair these mods/i }));
    await waitFor(() => {
      expect(screen.getByText(/Failed/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Open mod folder/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'open_mods_folder')).toBe(true);
    });
  });

  it('retrying after partial failure only re-attempts the failed mods', async () => {
    // First pass: BadMod fails. Second pass: BadMod succeeds. The panel must
    // skip the already-succeeded GoodMod when the user clicks repair again.
    let badAttempts = 0;
    registerInvokeHandler('repair_mod', (args) => {
      if (args?.name === 'BadMod') {
        badAttempts++;
        if (badAttempts === 1) throw new Error('try again');
      }
      return {
        name: String(args?.name ?? ''),
        version: '1.0',
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
      <Wrap
        modNames={['GoodMod', 'BadMod']}
        onRetryPublish={onRetryPublish}
      />,
    );
    const repairBtn = screen.getByRole('button', { name: /Repair these mods/i });
    await user.click(repairBtn);
    await waitFor(() => {
      expect(screen.getByText(/Failed/i)).toBeInTheDocument();
    });
    // First pass: one call per mod.
    expect(
      getInvokeCalls().filter((c) => c.cmd === 'repair_mod').length,
    ).toBe(2);
    // Click "Try repair again" — the button label flips back to the same
    // copy once repair finishes, so we can re-click it.
    await user.click(repairBtn);
    // Second pass: only BadMod re-attempted (GoodMod is skipped).
    await waitFor(() => {
      expect(badAttempts).toBe(2);
      expect(
        getInvokeCalls().filter((c) => c.cmd === 'repair_mod').length,
      ).toBe(3); // 2 from first pass + 1 BadMod retry
    });
    // Now everything succeeded → auto-retry publish fires.
    await waitFor(() => {
      expect(onRetryPublish).toHaveBeenCalledTimes(1);
    });
  });

  it('Cancel button calls onCancel', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Repair button is disabled while a repair pass is in flight', async () => {
    // Long-pending repair so the panel sits in the repairing state.
    registerInvokeHandler(
      'repair_mod',
      () => new Promise(() => {}),
    );
    const user = userEvent.setup();
    render(<Wrap modNames={['StuckMod']} />);
    const repairBtn = screen.getByRole('button', { name: /Repair these mods/i });
    await user.click(repairBtn);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Repairing/i }),
      ).toBeDisabled();
    });
  });
});
