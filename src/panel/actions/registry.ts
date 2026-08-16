/**
 * Panel action wiring: register every panel action in one place.
 *
 * @module @dsh-feishu/dsh-feishu/panel/actions/registry
 */

import { PanelActionRegistry } from './ActionRegistry.js';
import { COMMAND_ACTIONS } from './CommandActions.js';
import { NAVIGATOR_ACTIONS } from './NavigatorActions.js';
import { PICK_ACTIONS } from './PickActions.js';
import { SESSION_ACTIONS } from './SessionActions.js';

/** Build the panel action registry with every registered action. */
export function buildPanelActionRegistry(): PanelActionRegistry {
  const registry = new PanelActionRegistry();
  for (const action of [
    ...NAVIGATOR_ACTIONS,
    ...PICK_ACTIONS,
    ...SESSION_ACTIONS,
    ...COMMAND_ACTIONS,
  ]) {
    registry.register(action);
  }
  return registry;
}
