/**
 * Panel view wiring: register every view state in one place.
 *
 * @module @dsh-feishu/dsh-feishu/panel/views/registry
 */

import { PanelViewRegistry } from './PanelViewState.js';
import {
  ConfirmViewState,
  InputViewState,
  MenuViewState,
  ModelPickerViewState,
  PermissionPickerViewState,
  RepoPickerViewState,
  SessionDetailViewState,
  SessionsViewState,
} from './PanelViewStates.js';

/** Build the panel view registry with every registered view state. */
export function buildPanelViewRegistry(): PanelViewRegistry {
  const registry = new PanelViewRegistry();
  for (const state of [
    new MenuViewState(),
    new InputViewState(),
    new ConfirmViewState(),
    new SessionsViewState(),
    new SessionDetailViewState(),
    new RepoPickerViewState(),
    new ModelPickerViewState(),
    new PermissionPickerViewState(),
  ]) {
    registry.register(state);
  }
  return registry;
}
