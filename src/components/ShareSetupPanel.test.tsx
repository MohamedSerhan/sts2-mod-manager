import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ShareSetupPanel } from './ShareSetupPanel';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

/** Loud lookup — throws if the button text isn't found so silent regressions
 *  surface as the test failing instead of a no-op success. */
function getButton(label: RegExp | string): HTMLButtonElement {
  const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
  const matcher = typeof label === 'string'
    ? (b: HTMLButtonElement) => b.textContent?.trim() === label
    : (b: HTMLButtonElement) => label.test(b.textContent?.trim() ?? '');
  const btn = buttons.find(matcher);
  if (!btn) {
    throw new Error(
      `Button matching ${String(label)} not found. Buttons present: ${buttons.map((b) => `"${b.textContent}"`).join(', ')}`,
    );
  }
  return btn;
}

describe('<ShareSetupPanel>', () => {
  it('renders heading and three plain-language explanation lines', () => {
    render(
      <AllProviders>
        <ShareSetupPanel onSaved={() => {}} onConfigureLater={() => {}} />
      </AllProviders>,
    );
    expect(screen.getByRole('heading', { name: 'Set up sharing' })).toBeInTheDocument();
    // Three discrete explanation paragraphs — each is its own DOM element.
    expect(
      screen.getByText(/To share modpacks with friends, the app saves your modpack list to a small public GitHub repository\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/GitHub is free, and the app only needs permission to manage that one repository\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Your friends don't need a GitHub account/),
    ).toBeInTheDocument();
  });

  it('renders the "Open GitHub to create a token" button and opens the scoped URL', async () => {
    const opened: string[] = [];
    registerInvokeHandler('open_external_url', (args) => {
      opened.push(String((args as { url: string }).url));
      return true;
    });
    const user = userEvent.setup();
    render(
      <AllProviders>
        <ShareSetupPanel onSaved={() => {}} onConfigureLater={() => {}} />
      </AllProviders>,
    );
    const linkBtn = getButton(/Open GitHub to create a token/);
    await user.click(linkBtn);
    await waitFor(() => {
      expect(opened).toEqual([
        'https://github.com/settings/tokens/new?scopes=public_repo&description=sts2-mod-manager',
      ]);
    });
  });

  it('renders a password-type token input with the i18n aria-label', () => {
    render(
      <AllProviders>
        <ShareSetupPanel onSaved={() => {}} onConfigureLater={() => {}} />
      </AllProviders>,
    );
    const input = screen.getByLabelText('Paste your token here') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.type).toBe('password');
  });

  it('Save button is disabled when the token field is empty', () => {
    render(
      <AllProviders>
        <ShareSetupPanel onSaved={() => {}} onConfigureLater={() => {}} />
      </AllProviders>,
    );
    const saveBtn = getButton('Save and continue');
    expect(saveBtn).toBeDisabled();
  });

  it('Save button enables once a non-whitespace token is typed', async () => {
    const user = userEvent.setup();
    render(
      <AllProviders>
        <ShareSetupPanel onSaved={() => {}} onConfigureLater={() => {}} />
      </AllProviders>,
    );
    const input = screen.getByLabelText('Paste your token here');
    await user.type(input, 'ghp_abc123');
    const saveBtn = getButton('Save and continue');
    expect(saveBtn).not.toBeDisabled();
  });

  it('Save calls set_github_token with the typed token and then onSaved', async () => {
    let savedToken: string | null = null;
    registerInvokeHandler('set_github_token', (args) => {
      savedToken = String((args as { token: string }).token);
      return true;
    });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(
      <AllProviders>
        <ShareSetupPanel onSaved={onSaved} onConfigureLater={() => {}} />
      </AllProviders>,
    );
    const input = screen.getByLabelText('Paste your token here');
    await user.type(input, 'ghp_secrettoken');
    const saveBtn = getButton('Save and continue');
    await user.click(saveBtn);
    await waitFor(() => {
      expect(savedToken).toBe('ghp_secrettoken');
    });
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    // Backend was called with the trimmed token argument.
    const setCall = getInvokeCalls().find((c) => c.cmd === 'set_github_token');
    expect(setCall).toBeDefined();
    expect(setCall!.args).toEqual({ token: 'ghp_secrettoken' });
  });

  it('Save trims whitespace before sending to the backend', async () => {
    let savedToken: string | null = null;
    registerInvokeHandler('set_github_token', (args) => {
      savedToken = String((args as { token: string }).token);
      return true;
    });
    const user = userEvent.setup();
    render(
      <AllProviders>
        <ShareSetupPanel onSaved={() => {}} onConfigureLater={() => {}} />
      </AllProviders>,
    );
    const input = screen.getByLabelText('Paste your token here');
    await user.type(input, '   ghp_padded   ');
    const saveBtn = getButton('Save and continue');
    await user.click(saveBtn);
    await waitFor(() => {
      expect(savedToken).toBe('ghp_padded');
    });
  });

  it('Save failure surfaces an inline role="alert" retry message and does NOT call onSaved', async () => {
    registerInvokeHandler('set_github_token', () => {
      throw new Error('invalid token');
    });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(
      <AllProviders>
        <ShareSetupPanel onSaved={onSaved} onConfigureLater={() => {}} />
      </AllProviders>,
    );
    const input = screen.getByLabelText('Paste your token here');
    await user.type(input, 'bad-token');
    const saveBtn = getButton('Save and continue');
    await user.click(saveBtn);
    await waitFor(() => {
      // Scope to our panel's inline error — there is a global toast region
      // also rendered with role="alert" by ToastContext, so a top-level
      // getByRole('alert') would match both.
      const alerts = screen.getAllByRole('alert');
      const inline = alerts.find((el) => /didn't work/i.test(el.textContent ?? ''));
      expect(inline).toBeDefined();
    });
    expect(onSaved).not.toHaveBeenCalled();
    // Save button is re-enabled so the user can edit and retry.
    expect(getButton('Save and continue')).not.toBeDisabled();
  });

  it('"Configure later in Settings" calls onConfigureLater', async () => {
    const onConfigureLater = vi.fn();
    const user = userEvent.setup();
    render(
      <AllProviders>
        <ShareSetupPanel onSaved={() => {}} onConfigureLater={onConfigureLater} />
      </AllProviders>,
    );
    const escapeBtn = getButton('Configure later in Settings');
    await user.click(escapeBtn);
    expect(onConfigureLater).toHaveBeenCalledTimes(1);
  });

  it('Save is disabled while in flight and shows the saving label', async () => {
    let resolveSave!: () => void;
    registerInvokeHandler(
      'set_github_token',
      () => new Promise<boolean>((res) => { resolveSave = () => res(true); }),
    );
    const user = userEvent.setup();
    render(
      <AllProviders>
        <ShareSetupPanel onSaved={() => {}} onConfigureLater={() => {}} />
      </AllProviders>,
    );
    const input = screen.getByLabelText('Paste your token here');
    await user.type(input, 'ghp_x');
    const saveBtn = getButton('Save and continue');
    await user.click(saveBtn);
    // While in flight: button label flips to the saving copy and is disabled.
    await waitFor(() => {
      expect(getButton(/Saving/)).toBeDisabled();
    });
    resolveSave();
    await waitFor(() => {
      expect(getButton(/Save and continue/)).toBeInTheDocument();
    });
  });
});
