import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

type User = ReturnType<typeof userEvent.setup>;
type Name = string | RegExp;

/**
 * Interact with the custom <Select> dropdown (which replaced native
 * <select>). Native helpers like `user.selectOptions` only work on real
 * <select> elements, so tests open the trigger and click an option instead.
 */

/** Open the dropdown identified by its accessible name. Returns the listbox. */
export async function openSelect(user: User, name: Name) {
  const combo = await screen.findByRole('combobox', { name });
  await user.click(combo);
  return screen.findByRole('listbox');
}

/** Open the dropdown by accessible name and click the option by its label. */
export async function chooseOption(user: User, selectName: Name, optionName: Name) {
  const listbox = await openSelect(user, selectName);
  await user.click(within(listbox).getByRole('option', { name: optionName }));
}
