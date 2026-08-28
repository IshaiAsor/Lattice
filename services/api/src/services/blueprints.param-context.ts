// The dispatch-time param-context loader moved to @lattice/scenes (F7.12), because google-home
// now executes scenes too and needed the same read. Re-exported under its original name so the
// blueprint services that use it keep pointing at a blueprints-named module.
export { loadParamContext } from '@lattice/scenes';
