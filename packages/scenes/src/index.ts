// @lattice/scenes — executing a user's stored scene, wherever the gesture came from.
//
// A scene is pressed from two surfaces now: the dashboard tile (services/api) and a voice command
// (services/google-home, F7.12). docs/CONVENTIONS.md is explicit that logic used by two services
// belongs in a package rather than copied, and this is logic worth protecting — three lifecycle
// gates and a reference-resolution contract that a second copy would quietly get wrong.
//
// The param-context loader travels with it: it is the same "resolve at the moment of dispatch"
// read, and it cannot live in @lattice/params without giving that pure package a database.

export { executeScene, type SceneExecutionResult } from './execute';
export { loadParamContext } from './param-context';
