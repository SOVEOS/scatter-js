import {
	Plugin,
	PluginTypes,
	Blockchains,
	Network,
	SocketService
} from 'scatterjs-core';

const proxy = (dummy, handler) => new Proxy(dummy, handler);
let cache = {};

export default class ScatterEOS extends Plugin {

    constructor(){
        super(Blockchains.EOS, PluginTypes.BLOCKCHAIN_SUPPORT);
    }

    hookProvider(network){
        return signargs => {
            return new Promise((resolve, reject) => {
                const payload = Object.assign(signargs, { blockchain:Blockchains.EOS, network, requiredFields:{} });
                SocketService.sendApiRequest({
                    type:'requestSignature',
                    payload
                }).then(x => resolve(x.signatures))
                  .catch(x => reject(x));
            })
        }
    }

    signatureProvider(...args){

        const throwIfNoIdentity = args[0];

        // Protocol will be deprecated.
        return (network, _eos, _options = {}) => {

            network = Network.fromJson(network);
            if(!network.isValid()) throw Error.noNetwork();
            const httpEndpoint = `${network.protocol}://${network.hostport()}`;

            const chainId = network.hasOwnProperty('chainId') && network.chainId.length ? network.chainId : _options.chainId;

            // The proxy stands between the eosjs object and scatter.
            // This is used to add special functionality like adding `requiredFields` arrays to transactions
            return proxy(_eos({httpEndpoint, chainId}), {
                get(eosInstance, method) {

                    let returnedFields = null;

                    return (...args) => {

                        if(args.find(arg => arg.hasOwnProperty('keyProvider'))) throw Error.usedKeyProvider();

                        // The signature provider which gets elevated into the user's Scatter
                        const signProvider = async signargs => {
                            throwIfNoIdentity();

                            const requiredFields = args.find(arg => arg.hasOwnProperty('requiredFields')) || {requiredFields:{}};
                            const payload = Object.assign(signargs, { blockchain:Blockchains.EOS, network, requiredFields:requiredFields.requiredFields });
                            const result = await SocketService.sendApiRequest({
                                type:'requestSignature',
                                payload
                            });

                            // No signature
                            if(!result) return null;

                            if(result.hasOwnProperty('signatures')){
                                // Holding onto the returned fields for the final result
                                returnedFields = result.returnedFields;

                                // Grabbing buf signatures from local multi sig sign provider
                                let multiSigKeyProvider = args.find(arg => arg.hasOwnProperty('signProvider'));
                                if(multiSigKeyProvider){
                                    result.signatures.push(multiSigKeyProvider.signProvider(signargs.buf, signargs.sign));
                                }

                                // Returning only the signatures to eosjs
                                return result.signatures;
                            }

                            return result;
                        };

                        return new Promise((resolve, reject) => {

                            // Moving to a caching system to avoid
                            // rebuilding internal eosjs caches
                            const getOrCache = () => {
                                const unique = JSON.stringify(Object.assign(_options, {httpEndpoint, chainId}));

                                if(_options.hasOwnProperty('breakCache')){
                                    if(cache.hasOwnProperty(unique)){
                                        delete cache[unique];
                                    }
                                }

                                if(!cache.hasOwnProperty(unique)) cache[unique] = _eos(Object.assign(_options, {
                                    httpEndpoint,
                                    signProvider,
                                    chainId
                                }));
                                return cache[unique];
                            };

                            let eos = getOrCache();

                            getOrCache()[method](...args)
                                .then(result => {

                                    // Standard method ( ie. not contract )
                                    if(!result.hasOwnProperty('fc')){
                                        result = Object.assign(result, {returnedFields});
                                        resolve(result);
                                        return;
                                    }

                                    // Catching chained promise methods ( contract .then action )
                                    const contractProxy = proxy(result, {
                                        get(instance,method){
                                            if(method === 'then') return instance[method];
                                            return (...args) => {
                                                return new Promise(async (res, rej) => {
                                                    instance[method](...args).then(actionResult => {
                                                        res(Object.assign(actionResult, {returnedFields}));
                                                    }).catch(rej);
                                                })

                                            }
                                        }
                                    });

                                    resolve(contractProxy);
                                }).catch(error => reject(error))
                        })
                    }
                }
            }); // Proxy

        }
    }
}

if(typeof window !== 'undefined') {
	window.ScatterEOS = ScatterEOS;
}
