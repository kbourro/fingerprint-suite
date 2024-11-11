"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.newInjectedPage = exports.newInjectedContext = exports.FingerprintInjector = void 0;
const fs_1 = require("fs");
const fingerprint_generator_1 = require("fingerprint-generator");
/**
 * Fingerprint injector class.
 * @class
 */
class FingerprintInjector {
    constructor() {
        Object.defineProperty(this, "utilsJs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: this._loadUtils()
        });
    }
    /**
     * Some HTTP headers depend on the request (for example Accept (with values application/json, image/png) etc.).
     *  This function filters out those headers and leaves only the browser-wide ones.
     * @param headers Headers to be filtered.
     * @returns Filtered headers.
     */
    onlyInjectableHeaders(headers, browserName) {
        const requestHeaders = [
            'accept-encoding',
            'accept',
            'cache-control',
            'pragma',
            'sec-fetch-dest',
            'sec-fetch-mode',
            'sec-fetch-site',
            'sec-fetch-user',
            'upgrade-insecure-requests',
        ];
        const filteredHeaders = { ...headers };
        requestHeaders.forEach((header) => {
            delete filteredHeaders[header];
        });
        // Chromium-based controlled browsers do not support `te` header.
        // Probably needs more investigation, but for now, we can just remove it.
        if (!(browserName?.toLowerCase().includes('firefox') ?? false)) {
            delete filteredHeaders.te;
        }
        return filteredHeaders;
    }
    /**
     * Adds init script to the browser context, so the fingerprint is changed before every document creation.
     * DISCLAIMER: Since Playwright does not support changing viewport and `user-agent` after the context is created,
     * you have to set it manually when the context is created. Check the Playwright usage example for more details.
     * @param browserContext Playwright browser context to be injected with the fingerprint.
     * @param fingerprint Browser fingerprint from [`fingerprint-generator`](https://github.com/apify/fingerprint-generator).
     */
    async attachFingerprintToPlaywright(browserContext, browserFingerprintWithHeaders) {
        const { fingerprint, headers } = browserFingerprintWithHeaders;
        const enhancedFingerprint = this._enhanceFingerprint(fingerprint);
        const content = this.getInjectableFingerprintFunction(enhancedFingerprint);
        const browserName = browserContext.browser()?.browserType().name();
        await browserContext.setExtraHTTPHeaders(this.onlyInjectableHeaders(headers, browserName));
        browserContext.on('page', (page) => {
            page.emulateMedia({ colorScheme: 'dark' }).catch(() => { });
        });
        await browserContext.addInitScript({
            content,
        });
    }
    /**
     * Adds script that is evaluated before every document creation.
     * Sets User-Agent and viewport using native puppeteer interface
     * @param page Puppeteer `Page` object to be injected with the fingerprint.
     * @param fingerprint Fingerprint from [`fingerprint-generator`](https://github.com/apify/fingerprint-generator).
     */
    async attachFingerprintToPuppeteer(page, browserFingerprintWithHeaders) {
        const { fingerprint, headers } = browserFingerprintWithHeaders;
        const enhancedFingerprint = this._enhanceFingerprint(fingerprint);
        const { screen, userAgent } = enhancedFingerprint;
        await page.setUserAgent(userAgent);
        const browserVersion = await page.browser().version();
        if (!browserVersion.toLowerCase().includes('firefox')) {
            await (await page.target().createCDPSession()).send('Page.setDeviceMetricsOverride', {
                screenHeight: screen.height,
                screenWidth: screen.width,
                width: screen.width,
                height: screen.height,
                mobile: /phone|android|mobile/i.test(userAgent),
                screenOrientation: screen.height > screen.width
                    ? { angle: 0, type: 'portraitPrimary' }
                    : { angle: 90, type: 'landscapePrimary' },
                deviceScaleFactor: screen.devicePixelRatio,
            });
            await page.setExtraHTTPHeaders(this.onlyInjectableHeaders(headers, browserVersion));
            await page.emulateMediaFeatures([
                { name: 'prefers-color-scheme', value: 'dark' },
            ]);
        }
        const injectableFingerprintFunction = this.getInjectableFingerprintFunction(enhancedFingerprint);
        const browser = page.browser();
        // Use Symbol to avoid potential name conflicts
        const interceptedSymbol = Symbol('cdpIntercepted');
        if (!browser[interceptedSymbol]) {
            try {
                // Get CDP session
                const client = await page.createCDPSession();
                // Enable necessary CDP domains
                await Promise.all([
                    client.send('Network.enable'),
                    client.send('ServiceWorker.enable'),
                ]);
                // Handle service worker requests
                client.on('Network.requestIntercepted', async ({ interceptionId, request }) => {
                    try {
                        // Create fetch options using original request properties
                        const fetchOptions = {
                            method: request.method,
                            headers: request.headers,
                            credentials: 'include',
                            // Include body for POST/PUT requests
                            ...(request.method !== 'GET'
                                && request.method !== 'HEAD'
                                && request.postData && {
                                body: request.postData,
                            }),
                        };
                        const response = await fetch(request.url, fetchOptions);
                        const script = await response.text();
                        // Get original response headers
                        const responseHeaders = [];
                        response.headers.forEach((value, key) => {
                            responseHeaders.push(`${key}: ${value}`);
                        });
                        const responseHeadersString = responseHeaders.join('\r\n');
                        await client.send('Network.continueInterceptedRequest', {
                            interceptionId,
                            rawResponse: Buffer.from([
                                `HTTP/1.1 ${response.status} ${response.statusText}`,
                                responseHeadersString,
                                'Content-Type: application/javascript',
                                '',
                                `${injectableFingerprintFunction}\n${script}`,
                            ].join('\r\n')).toString('base64'),
                        });
                    }
                    catch (error) {
                        // eslint-disable-next-line no-console
                        console.error('Failed to intercept request:', error);
                        await client.send('Network.continueInterceptedRequest', {
                            interceptionId,
                        });
                    }
                });
                // Enable request interception for service workers
                await client.send('Network.setRequestInterception', {
                    patterns: [{ resourceType: 'Script' }],
                });
                // Mark as intercepted
                browser[interceptedSymbol] = true;
                // Clean up when browser closes
                browser.on('disconnected', async () => {
                    try {
                        await client.detach();
                    }
                    catch (error) {
                        // Ignore detachment errors
                    }
                });
            }
            catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to set up Service Worker interception:', error);
            }
        }
        await page.evaluateOnNewDocument(injectableFingerprintFunction);
        await page.evaluateOnNewDocument((injectableFingerprintFunctionInternal) => {
            const selfObj = typeof window !== 'undefined' ? window : globalThis;
            // Worker
            if (typeof Worker !== 'undefined') {
                const OriginalWorker = selfObj.Worker;
                const WorkerOverride = class extends OriginalWorker {
                    constructor(scriptURL, options) {
                        const absoluteURL = new URL(scriptURL, document.baseURI).href;
                        const code = `
                        if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
                            ${injectableFingerprintFunctionInternal}
                        }
                        importScripts('${absoluteURL}');
                    `;
                        const blob = new Blob([code], {
                            type: 'application/javascript',
                        });
                        super(URL.createObjectURL(blob), options);
                    }
                };
                // Make it look native
                Object.defineProperties(WorkerOverride, {
                    name: {
                        value: 'Worker',
                        configurable: true,
                    },
                    toString: {
                        value: () => 'function Worker() { [native code] }',
                        configurable: true,
                    },
                });
                // Also hide the constructor toString
                Object.defineProperty(WorkerOverride.prototype.constructor, 'toString', {
                    value: () => 'function Worker() { [native code] }',
                    configurable: true,
                });
                selfObj.Worker = WorkerOverride;
            }
            // SharedWorker
            if (typeof SharedWorker !== 'undefined') {
                const OriginalSharedWorker = selfObj.SharedWorker;
                const SharedWorkerOverride = class extends OriginalSharedWorker {
                    constructor(scriptURL, options) {
                        const absoluteURL = new URL(scriptURL, document.baseURI).href;
                        const code = `
                        if (typeof SharedWorkerGlobalScope !== 'undefined' && self instanceof SharedWorkerGlobalScope) {
                            ${injectableFingerprintFunctionInternal}
                        }
                        importScripts('${absoluteURL}');
                    `;
                        const blob = new Blob([code], {
                            type: 'application/javascript',
                        });
                        super(URL.createObjectURL(blob), options);
                    }
                };
                // Make it look native
                Object.defineProperties(SharedWorkerOverride, {
                    name: {
                        value: 'SharedWorker',
                        configurable: true,
                    },
                    toString: {
                        value: () => 'function SharedWorker() { [native code] }',
                        configurable: true,
                    },
                });
                // Also hide the constructor toString
                Object.defineProperty(SharedWorkerOverride.prototype.constructor, 'toString', {
                    value: () => 'function SharedWorker() { [native code] }',
                    configurable: true,
                });
                selfObj.SharedWorker = SharedWorkerOverride;
            }
        }, injectableFingerprintFunction);
    }
    /**
     * Gets the override script that should be evaluated in the browser.
     */
    getInjectableScript(browserFingerprintWithHeaders) {
        const { fingerprint } = browserFingerprintWithHeaders;
        const enhancedFingerprint = this._enhanceFingerprint(fingerprint);
        return this.getInjectableFingerprintFunction(enhancedFingerprint);
    }
    /**
     * Create injection function string.
     * @param fingerprint Enhanced fingerprint.
     * @returns Script overriding browser fingerprint.
     */
    getInjectableFingerprintFunction(fingerprint) {
        function inject() {
            const { battery, navigator: { extraProperties, userAgentData, webdriver, ...navigatorProps }, screen: allScreenProps, videoCard, historyLength, audioCodecs, videoCodecs, mockWebRTC, slim,
            // @ts-expect-error internal browser code
             } = fp;
            const { 
            // window screen props
            outerHeight, outerWidth, devicePixelRatio, innerWidth, innerHeight, screenX, pageXOffset, pageYOffset, 
            // Document screen props
            clientWidth, clientHeight, 
            // Ignore hdr for now.
            hasHDR, 
            // window.screen props
            ...newScreen } = allScreenProps;
            const windowScreenProps = {
                innerHeight,
                outerHeight,
                outerWidth,
                innerWidth,
                screenX,
                pageXOffset,
                pageYOffset,
                devicePixelRatio,
            };
            const documentScreenProps = {
                clientHeight,
                clientWidth,
            };
            runHeadlessFixes();
            if (mockWebRTC)
                blockWebRTC();
            if (slim) {
                // @ts-expect-error internal browser code
                // eslint-disable-next-line dot-notation
                window['slim'] = true;
            }
            overrideIntlAPI(navigatorProps.language);
            overrideStatic();
            if (userAgentData) {
                overrideUserAgentData(userAgentData);
            }
            if (window.navigator.webdriver) {
                navigatorProps.webdriver = false;
            }
            overrideInstancePrototype(window.navigator, navigatorProps);
            overrideInstancePrototype(window.screen, newScreen);
            overrideWindowDimensionsProps(windowScreenProps);
            overrideDocumentDimensionsProps(documentScreenProps);
            overrideInstancePrototype(window.history, {
                length: historyLength,
            });
            overrideWebGl(videoCard);
            overrideCodecs(audioCodecs, videoCodecs);
            overrideBattery(battery);
        }
        const mainFunctionString = inject.toString();
        return `(()=>{${this.utilsJs}; const fp=${JSON.stringify(fingerprint)}; (${mainFunctionString})()})()`;
    }
    _enhanceFingerprint(fingerprint) {
        const { navigator, ...rest } = fingerprint;
        return {
            ...rest,
            navigator,
            userAgent: navigator.userAgent,
            historyLength: this._randomInRange(2, 6),
        };
    }
    /**
     * Loads the contents of the `utils.js` file, which contains the helper functions for the fingerprinting script.
     *
     * Loading this file dynamically bypasses the TypeScript compiler, which would otherwise mangle the code,
     * causing errors when executing it in the browser.
     */
    _loadUtils() {
        // path.join would be better here, but Vercel's build system doesn't like it (https://github.com/apify/fingerprint-suite/issues/135)
        const utilsJs = (0, fs_1.readFileSync)(`${__dirname}/utils.js`);
        return `\n${utilsJs}\n`;
    }
    _randomInRange(min, max) {
        return Math.floor(Math.random() * (max - min) + min);
    }
}
exports.FingerprintInjector = FingerprintInjector;
/**
 * Creates a new Playwright BrowserContext preinjected with a generated fingerprint.
 * @param browser Playwright Browser instance.
 * @param options.fingerprintOptions Options for the underlying FingerprintGenerator instance.
 * @param options.newContextOptions Options for the new context creation.
 *  > Note: Setting `userAgent` or `viewport` in `newContextOptions` will override the values from the generated fingerprint.
 * @returns BrowserContext with injected fingerprint.
 */
async function newInjectedContext(browser, options) {
    const generator = new fingerprint_generator_1.FingerprintGenerator();
    const fingerprintWithHeaders = options?.fingerprint
        ?? generator.getFingerprint(options?.fingerprintOptions ?? {});
    const { fingerprint, headers } = fingerprintWithHeaders;
    const context = await browser.newContext({
        userAgent: fingerprint.navigator.userAgent,
        colorScheme: 'dark',
        ...options?.newContextOptions,
        viewport: {
            width: fingerprint.screen.width,
            height: fingerprint.screen.height,
            ...options?.newContextOptions?.viewport,
        },
        extraHTTPHeaders: {
            'accept-language': headers['accept-language'],
            ...options?.newContextOptions?.extraHTTPHeaders,
        },
    });
    const injector = new FingerprintInjector();
    await injector.attachFingerprintToPlaywright(context, fingerprintWithHeaders);
    return context;
}
exports.newInjectedContext = newInjectedContext;
async function newInjectedPage(browser, options) {
    const generator = new fingerprint_generator_1.FingerprintGenerator();
    const fingerprintWithHeaders = options?.fingerprint
        ?? generator.getFingerprint(options?.fingerprintOptions ?? {});
    const page = await browser.newPage();
    const injector = new FingerprintInjector();
    await injector.attachFingerprintToPuppeteer(page, fingerprintWithHeaders);
    return page;
}
exports.newInjectedPage = newInjectedPage;
//# sourceMappingURL=fingerprint-injector.js.map