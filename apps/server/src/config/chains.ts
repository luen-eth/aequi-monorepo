import { mainnet, bsc as bscChain } from 'viem/chains'
import type { ChainConfig, ChainKey } from '../types'
import { FeeAmount as PancakeFeeAmount } from '@pancakeswap/v3-sdk'
import { FeeAmount } from '@uniswap/v3-sdk'
import { appConfig } from './app-config'

export const CHAIN_CONFIGS: Record<ChainKey, ChainConfig> = {
    ethereum: {
        key: 'ethereum',
        id: mainnet.id,
        name: 'Ethereum',
        nativeCurrencySymbol: mainnet.nativeCurrency.symbol,
        wrappedNativeAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        rpcUrls: appConfig.rpc.ethereum.length ? appConfig.rpc.ethereum : Array.from(mainnet.rpcUrls.default.http),
        fallbackRpcUrls: appConfig.rpc.ethereumFallback,
        disablePublicRpcRegistry: appConfig.rpc.ethereum.length > 0,
        viemChain: mainnet,
        dexes: [
            {
                id: 'uniswap-v2',
                label: 'Uniswap V2',
                protocol: 'uniswap',
                version: 'v2',
                factoryAddress: appConfig.dex.uniswapV2Factory,
                routerAddress: appConfig.dex.uniswapV2Router,
            },
            {
                id: 'uniswap-v3',
                label: 'Uniswap V3',
                protocol: 'uniswap',
                version: 'v3',
                factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
                routerAddress: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
                quoterAddress: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
                feeTiers: [FeeAmount.LOWEST, FeeAmount.LOW, FeeAmount.MEDIUM],
            },
        ],
    },
    bsc: {
        key: 'bsc',
        id: bscChain.id,
        name: 'BNB Smart Chain',
        nativeCurrencySymbol: bscChain.nativeCurrency.symbol,
        wrappedNativeAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        rpcUrls: (() => {
            if (appConfig.rpc.bsc.length) {
                return appConfig.rpc.bsc
            }
            const defaults = bscChain.rpcUrls.default?.http ?? []
            return defaults.length ? Array.from(defaults) : ['https://bsc.drpc.org']
        })(),
        fallbackRpcUrls: appConfig.rpc.bscFallback,
        disablePublicRpcRegistry: appConfig.rpc.bsc.length > 0,
        viemChain: bscChain,
        dexes: [
            {
                id: 'pancake-v2',
                label: 'PancakeSwap V2',
                protocol: 'pancakeswap',
                version: 'v2',
                factoryAddress: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
                routerAddress: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
            },
            {
                id: 'pancake-v3',
                label: 'PancakeSwap V3',
                protocol: 'pancakeswap',
                version: 'v3',
                factoryAddress: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
                routerAddress: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
                quoterAddress: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
                feeTiers: [PancakeFeeAmount.LOWEST, PancakeFeeAmount.LOW, PancakeFeeAmount.MEDIUM],
            },
            {
                id: "uniswap-v2",
                label: "Uniswap V2",
                protocol: "uniswap",
                version: "v2",
                factoryAddress: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
                routerAddress: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
            },
            {
                id: "uniswap-v3",
                label: "Uniswap V3",
                protocol: "uniswap",
                version: "v3",
                factoryAddress: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
                routerAddress: '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',
                quoterAddress: '0x78D78E420Da98ad378D7799bE8f4AF69033EB077',
                feeTiers: [FeeAmount.LOWEST, FeeAmount.LOW, FeeAmount.MEDIUM],
            },
        ],
    },
}

export const SUPPORTED_CHAINS = Object.keys(CHAIN_CONFIGS) as ChainKey[]

export const getChainConfig = (chain: string): ChainConfig | null => {
    const key = chain.toLowerCase() as ChainKey
    return CHAIN_CONFIGS[key] ?? null
}
