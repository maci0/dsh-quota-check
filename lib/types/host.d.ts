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
/** Disposer returned by every host registration. */
export type Disposable = () => void;
/** One registered settings namespace, as `describe()` reports it. */
export interface SettingsDescriptorLike {
    /** Registered namespace name, e.g. `llm-pi-ai`. */
    readonly ns: string;
    /** Current resolved value: schema defaults, then base, then the user layer. */
    readonly value: unknown;
}
/** One configurable provider route, as the LLM registry declares it. */
export interface ConfigurableProviderLike {
    /** Route id the model picker shows, e.g. `zai`. */
    readonly provider: string;
    /** Display name for the provider, when it declares one. */
    readonly displayName?: string;
    /** Settings namespace holding this route's profile. */
    readonly settingsNs: string;
    /** Path inside that namespace's value to this route's profile. */
    readonly settingsPath: readonly string[];
}
/** The slice of the LLM registry this plugin reads. */
export interface LlmRegistryLike {
    /**
     * List every declared configurable provider, registered or dormant.
     * @returns detached directory entries in declaration order.
     */
    listConfigurableProviders(): readonly ConfigurableProviderLike[];
}
/** The slice of the credentials service this plugin reads. */
export interface CredentialsLike {
    /**
     * Resolve one credential reference to its value.
     * @param ref - environment-variable-style reference name.
     * @returns the resolved value, or `undefined` when nothing is stored.
     */
    resolve(ref: string): Promise<{
        readonly value: string;
    } | undefined>;
}
/** Request subset the trust fence reads. */
export interface RequestLike {
    /** Request method, uppercased by the caller. */
    readonly method?: string | undefined;
    /** Request target, including the query string. */
    readonly url?: string | undefined;
    /** Request headers, read by the composition's trust fence. */
    readonly headers: object | undefined;
}
/** Response subset this plugin writes. */
export interface ResponseLike {
    /** HTTP status code. */
    statusCode: number;
    /** Set one response header. */
    setHeader(name: string, value: string): void;
    /** End the response, optionally with a body. */
    end(body?: string): void;
}
/** One exact-path route registration. */
export interface WebRouteLike {
    /** Match kind; this plugin registers only exact paths. */
    readonly kind: 'exact';
    /** Absolute pathname, no trailing slash. */
    readonly path: string;
    /** Owns the full response lifecycle. */
    handler: (req: RequestLike, res: ResponseLike) => void | Promise<void>;
}
/** The slice of the HTTP carrier this plugin registers on. */
export interface WebServerLike {
    /**
     * Register one route.
     * @param route - path, match kind, and handler.
     * @returns the disposer that withdraws it.
     */
    register(route: WebRouteLike): Disposable;
}
/** The composition's trust fence, when one is mounted. */
export interface ConnectionLike {
    /**
     * Reject an untrusted or unauthenticated request.
     * @param request - headers of the incoming request.
     * @returns the rejection status, or `undefined` when the request may proceed.
     */
    requestRejection(request: {
        readonly headers: object | undefined;
    }): 401 | 403 | undefined;
}
/**
 * Structural view of the Cordis context the host half uses.
 *
 * `inject` below guarantees `webServer`; everything else is optional and read
 * through `get`, so a composition without the settings, credentials, or LLM
 * seam degrades to "no figure to report" instead of failing to mount.
 */
export interface HostContext {
    /** Run `callback` when the named services are available. */
    inject(dependencies: readonly string[], callback: (scope: HostContext) => void): unknown;
    /** Bind a registration's lifetime to this plugin's fiber. */
    effect(callback: () => Disposable | void, label?: string): unknown;
    /**
     * Subscribe to a host event. This plugin watches `loader/volatile-update`,
     * which is what a settings write emits once the live row references moved.
     * @param event - the event name.
     * @param listener - the callback.
     * @returns the disposer that removes this listener.
     */
    on(event: 'loader/volatile-update', listener: () => void): Disposable;
    /** Read one optional service. */
    get(name: string): unknown;
    /** Structured log surface. */
    readonly logger: {
        warn(message: string): void;
        error(message: string): void;
    };
    /** HTTP route carrier (guaranteed by `inject`). */
    readonly webServer: WebServerLike;
}
