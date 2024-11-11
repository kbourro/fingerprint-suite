"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeneratorNetworksCreator = void 0;
const tslib_1 = require("tslib");
const fs_1 = tslib_1.__importDefault(require("fs"));
const path_1 = tslib_1.__importDefault(require("path"));
const generative_bayesian_network_1 = require("generative-bayesian-network");
const node_fetch_1 = tslib_1.__importDefault(require("node-fetch"));
const browserHttpNodeName = '*BROWSER_HTTP';
const httpVersionNodeName = '*HTTP_VERSION';
const browserNodeName = '*BROWSER';
const operatingSystemNodeName = '*OPERATING_SYSTEM';
const deviceNodeName = '*DEVICE';
const missingValueDatasetToken = '*MISSING_VALUE*';
const nonGeneratedNodes = [
    browserHttpNodeName,
    browserNodeName,
    operatingSystemNodeName,
    deviceNodeName,
];
const STRINGIFIED_PREFIX = '*STRINGIFIED*';
const PLUGIN_CHARACTERISTICS_ATTRIBUTES = [
    'plugins',
    'mimeTypes',
];
async function prepareRecords(records, preprocessingType) {
    const cleanedRecords = records
        .filter(({ requestFingerprint: { headers }, browserFingerprint, }) => {
        return (headers['user-agent'] ?? headers['User-Agent']) === browserFingerprint.userAgent;
    })
        .filter(({ browserFingerprint: { screen: { width, height }, userAgent, }, }) => ((width >= 1280 && width > height) || (width < height && /phone|android|mobile/i.test(userAgent))))
        .map((record) => ({ ...record, userAgent: record.browserFingerprint.userAgent }));
    // TODO this could break if the list is not there anymore
    // The robots list is available under the MIT license, for details see https://github.com/atmire/COUNTER-Robots/blob/master/LICENSE
    const robotUserAgents = await (0, node_fetch_1.default)('https://raw.githubusercontent.com/atmire/COUNTER-Robots/master/COUNTER_Robots_list.json')
        .then(async (res) => res.json());
    const deconstructedRecords = [];
    const userAgents = new Set();
    for (let x = 0; x < cleanedRecords.length; x++) {
        let record = cleanedRecords[x];
        const { userAgent } = record;
        let useRecord = !userAgent.match(/(bot|bots|slurp|spider|crawler|crawl)\b/i)
            && !robotUserAgents.some((robot) => userAgent.match(new RegExp(robot.pattern, 'i')));
        if (useRecord) {
            if (preprocessingType === 'headers') {
                const { httpVersion } = record.requestFingerprint;
                record = record.requestFingerprint.headers;
                record[httpVersionNodeName] = `_${httpVersion}_`;
                if (record[httpVersionNodeName] === '_1.1_') {
                    useRecord = !('user-agent' in record);
                }
            }
            else {
                record = record.browserFingerprint;
            }
        }
        if (useRecord) {
            deconstructedRecords.push(record);
        }
        else {
            userAgents.add(userAgent);
        }
    }
    const attributes = new Set();
    deconstructedRecords.forEach((record) => {
        Object.keys(record).forEach((key) => {
            attributes.add(key);
        });
    });
    const reorganizedRecords = [];
    for (const record of deconstructedRecords) {
        const reorganizedRecord = {};
        for (const attribute of attributes) {
            if (!(attribute in record) || record[attribute] === undefined) {
                reorganizedRecord[attribute] = missingValueDatasetToken;
            }
            else {
                reorganizedRecord[attribute] = record[attribute];
            }
        }
        reorganizedRecords.push(reorganizedRecord);
    }
    return reorganizedRecords;
}
class GeneratorNetworksCreator {
    getDeviceOS(userAgent) {
        let operatingSystem = missingValueDatasetToken;
        if (/windows/i.test(userAgent)) {
            operatingSystem = 'windows';
        }
        let device = 'desktop';
        if (/phone|android|mobile/i.test(userAgent)) {
            device = 'mobile';
            if (/iphone|mac/i.test(userAgent)) {
                operatingSystem = 'ios';
            }
            else if (/android/i.test(userAgent)) {
                operatingSystem = 'android';
            }
        }
        else if (/linux/i.test(userAgent)) {
            operatingSystem = 'linux';
        }
        else if (/mac/i.test(userAgent)) {
            operatingSystem = 'macos';
        }
        return { device, operatingSystem };
    }
    getBrowserNameVersion(userAgent) {
        const canonicalNames = {
            chrome: 'chrome',
            crios: 'chrome',
            firefox: 'firefox',
            fxios: 'firefox',
            safari: 'safari',
            edge: 'edge',
            edg: 'edge',
            edga: 'edge',
            edgios: 'edge',
        };
        const unsupportedBrowsers = /opr|yabrowser|SamsungBrowser|UCBrowser|vivaldi/ig;
        const edge = /(edg(a|ios|e)?)\/([0-9.]*)/ig;
        const supportedBrowsers = /(firefox|fxios|chrome|crios|safari)\/([0-9.]*)/ig;
        if (unsupportedBrowsers.test(userAgent)) {
            return missingValueDatasetToken;
        }
        if (edge.test(userAgent)) {
            const match = userAgent.match(edge)[0].split('/');
            return `edge/${match[1]}`;
        }
        if (supportedBrowsers.test(userAgent)) {
            const match = userAgent.match(supportedBrowsers)[0].split('/');
            return `${canonicalNames[match[0].toLowerCase()]}/${match[1]}`;
        }
        return missingValueDatasetToken;
    }
    async prepareHeaderGeneratorFiles(datasetPath, resultsPath) {
        const datasetText = fs_1.default.readFileSync(datasetPath, { encoding: 'utf8' });
        const records = await prepareRecords(JSON.parse(datasetText), 'headers');
        const inputGeneratorNetwork = new generative_bayesian_network_1.BayesianNetwork({ path: path_1.default.join(__dirname, 'network_structures', 'input-network-structure.zip') });
        const headerGeneratorNetwork = new generative_bayesian_network_1.BayesianNetwork({ path: path_1.default.join(__dirname, 'network_structures', 'header-network-structure.zip') });
        // eslint-disable-next-line dot-notation
        const desiredHeaderAttributes = Object.keys(headerGeneratorNetwork['nodesByName'])
            .filter((attribute) => !nonGeneratedNodes.includes(attribute));
        let selectedRecords = records.map((record) => {
            return Object.entries(record).reduce((acc, [key, value]) => {
                if (desiredHeaderAttributes.includes(key))
                    acc[key] = value ?? missingValueDatasetToken;
                return acc;
            }, {});
        });
        selectedRecords = selectedRecords.map((record) => {
            const userAgent = (record['user-agent'] !== missingValueDatasetToken ? record['user-agent'] : record['User-Agent']).toLowerCase();
            const browser = this.getBrowserNameVersion(userAgent);
            const { device, operatingSystem } = this.getDeviceOS(userAgent);
            return {
                ...record,
                [browserNodeName]: browser,
                [operatingSystemNodeName]: operatingSystem,
                [deviceNodeName]: device,
                [browserHttpNodeName]: `${browser}|${record[httpVersionNodeName].startsWith('_1') ? '1' : '2'}`,
            };
        });
        headerGeneratorNetwork.setProbabilitiesAccordingToData(selectedRecords);
        inputGeneratorNetwork.setProbabilitiesAccordingToData(selectedRecords);
        const inputNetworkDefinitionPath = path_1.default.join(resultsPath, 'input-network-definition.zip');
        const headerNetworkDefinitionPath = path_1.default.join(resultsPath, 'header-network-definition.zip');
        const browserHelperFilePath = path_1.default.join(resultsPath, 'browser-helper-file.json');
        headerGeneratorNetwork.saveNetworkDefinition({ path: headerNetworkDefinitionPath });
        inputGeneratorNetwork.saveNetworkDefinition({ path: inputNetworkDefinitionPath });
        const uniqueBrowsersAndHttps = Array.from(new Set(selectedRecords.map((record) => record[browserHttpNodeName])));
        fs_1.default.writeFileSync(browserHelperFilePath, JSON.stringify(uniqueBrowsersAndHttps));
    }
    async prepareFingerprintGeneratorFiles(datasetPath, resultsPath) {
        const datasetText = fs_1.default.readFileSync(datasetPath, { encoding: 'utf8' }).replace(/^\ufeff/, '');
        const records = await prepareRecords(JSON.parse(datasetText), 'fingerprints');
        for (let x = 0; x < records.length; x++) {
            // eslint-disable-next-line no-console
            if (x % 1000 === 0)
                console.log(`Processing record ${x} of ${records.length}`);
            const record = records[x];
            const pluginCharacteristics = {};
            for (const pluginCharacteristicsAttribute of PLUGIN_CHARACTERISTICS_ATTRIBUTES) {
                if (pluginCharacteristicsAttribute in record) {
                    if (record[pluginCharacteristicsAttribute] !== '') {
                        pluginCharacteristics[pluginCharacteristicsAttribute] = record[pluginCharacteristicsAttribute];
                    }
                    delete record[pluginCharacteristicsAttribute];
                }
            }
            record.pluginsData = Object.keys(pluginCharacteristics).length !== 0 ? pluginCharacteristics : missingValueDatasetToken;
            for (const attribute of Object.keys(record)) {
                if ([null, '', undefined].includes(record[attribute])) {
                    record[attribute] = missingValueDatasetToken;
                }
                else {
                    record[attribute] = (typeof record[attribute] === 'string' || record[attribute] instanceof String)
                        ? record[attribute]
                        : (STRINGIFIED_PREFIX + JSON.stringify(record[attribute]));
                }
            }
            records[x] = record;
        }
        const fingerprintGeneratorNetwork = new generative_bayesian_network_1.BayesianNetwork({ path: path_1.default.join(__dirname, 'network_structures', 'fingerprint-network-structure.zip') });
        // eslint-disable-next-line dot-notation
        const desiredFingerprintAttributes = Object.keys(fingerprintGeneratorNetwork['nodesByName']);
        const selectedRecords = records.map((record) => {
            return Object.entries(record).reduce((acc, [key, value]) => {
                if (desiredFingerprintAttributes.includes(key))
                    acc[key] = value ?? missingValueDatasetToken;
                return acc;
            }, {});
        });
        const fingerprintNetworkDefinitionPath = path_1.default.join(resultsPath, 'fingerprint-network-definition.zip');
        // eslint-disable-next-line no-console
        console.log('Building the fingerprint network...');
        fingerprintGeneratorNetwork.setProbabilitiesAccordingToData(selectedRecords);
        fingerprintGeneratorNetwork.saveNetworkDefinition({ path: fingerprintNetworkDefinitionPath });
    }
}
exports.GeneratorNetworksCreator = GeneratorNetworksCreator;
//# sourceMappingURL=generator-networks-creator.js.map