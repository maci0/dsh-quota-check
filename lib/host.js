/**
 * The slice of the DeepSeek Harness host surface this plugin uses, declared
 * structurally.
 *
 * The plugin installs from outside the harness checkout and has no runtime
 * dependency on harness packages: the services it reaches are typed here, and
 * a composition that mounts none of them simply omits that capability. The
 * same shape also lets the unit tests drive `apply` with a plain fake context.
 *
 * @module dsh-quota-check/host
 */
export {};
