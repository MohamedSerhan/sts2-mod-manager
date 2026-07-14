import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AllProviders } from '../__test__/providers';
import type { UpdatePlanItem } from '../types';
import { UpdatePlanSheet } from './UpdatePlanSheet';

const plan = (name: string, id: string, capability: UpdatePlanItem['capability'], provider: string, target: string | null): UpdatePlanItem => ({
  target: { name, mod_version_id: id, folder_name: `${provider}-${id}` }, current_version: '1.0.0', target_version: target,
  provider, source: provider === 'nexus' ? 'https://www.nexusmods.com/slaythespire2/mods/1' : null,
  capability, reason: '', selectable: capability === 'downloadable', pending: true,
});

describe('<UpdatePlanSheet>', () => {
  it('reviews every provider and applies only selected GitHub stable identities', async () => {
    const user = userEvent.setup();
    const plans = [
      plan('Same Name', 'github-a', 'downloadable', 'github', '2.0.0'),
      plan('Same Name', 'github-b', 'downloadable', 'github', '3.0.0'),
      plan('Nexus Mod', 'nexus-a', 'manual', 'nexus', '4.0.0'),
      plan('Steam Mod', 'steam-a', 'steam-managed', 'steam', '1234567890123456789'),
      plan('Frozen Mod', 'frozen-a', 'frozen', 'github', '5.0.0'),
    ];
    const onApply = vi.fn(async () => []);
    const onOpenSource = vi.fn(async () => undefined);
    const onUnfreeze = vi.fn(async () => undefined);
    render(<AllProviders><UpdatePlanSheet plans={plans} applying={false} onApply={onApply} onClose={vi.fn()} onOpenSource={onOpenSource} onUnfreeze={onUnfreeze} /></AllProviders>);

    expect(screen.getByText('Manual download')).toBeInTheDocument();
    expect(screen.getByText('Managed in Steam')).toBeInTheDocument();
    expect(screen.queryByText(/1234567890123456789/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open manual page' }));
    expect(onOpenSource).toHaveBeenCalledWith('https://www.nexusmods.com/slaythespire2/mods/1');
    await user.click(screen.getByRole('button', { name: 'Unfreeze' }));
    expect(onUnfreeze).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ mod_version_id: 'frozen-a' }),
    }));
    const sameNameChecks = screen.getAllByRole('checkbox', { name: /Select Same Name/ });
    await user.click(sameNameChecks[1]);
    await user.click(screen.getByRole('button', { name: 'Download 1 selected GitHub update to Versions' }));
    expect(onApply).toHaveBeenCalledWith([expect.objectContaining({ target: expect.objectContaining({ mod_version_id: 'github-a' }), target_version: '2.0.0' })]);
  });

  it('select none prevents apply and select all restores every downloadable row', async () => {
    const user = userEvent.setup();
    const plans = [plan('A', 'a', 'downloadable', 'github', '2'), plan('B', 'b', 'downloadable', 'github', '3')];
    render(<AllProviders><UpdatePlanSheet plans={plans} applying={false} onApply={vi.fn(async () => [])} onClose={vi.fn()} onOpenSource={vi.fn()} onUnfreeze={vi.fn()} /></AllProviders>);
    await user.click(screen.getByRole('button', { name: 'Select none' }));
    expect(screen.getByRole('button', { name: 'Download 0 selected GitHub updates to Versions' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByRole('button', { name: 'Download 2 selected GitHub updates to Versions' })).toBeEnabled();
  });

  it('maps apply results by provider when target identities are shared', async () => {
    const user = userEvent.setup();
    const plans = [
      plan('Shared Mod', 'shared', 'downloadable', 'github', '2.0.0'),
      plan('Shared Mod', 'shared', 'manual', 'nexus', '3.0.0'),
    ];
    const onApply = vi.fn(async () => [{
      target: plans[0].target,
      provider: 'github',
      mod_name: 'Shared Mod',
      expected_version: '2.0.0',
      actual_version: '2.0.0',
      status: 'updated' as const,
      message: null,
      updated_mod: null,
    }]);
    render(<AllProviders><UpdatePlanSheet plans={plans} applying={false} onApply={onApply} onClose={vi.fn()} onOpenSource={vi.fn()} onUnfreeze={vi.fn()} /></AllProviders>);

    expect(screen.getAllByText('GitHub')).toHaveLength(1);
    expect(screen.getAllByText('Nexus')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /Download 1 selected GitHub update/ }));
    expect(screen.getByText('Downloaded to Versions')).toBeInTheDocument();
    expect(screen.getByText('Manual download')).toBeInTheDocument();
  });
});
