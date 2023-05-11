import '../moduleAlias'
import BaseWatcher from './classes/BaseWatcher'
import L1Bridge from './classes/L1Bridge'
import MerkleTree from 'src/utils/MerkleTree'
import chainSlugToId from 'src/utils/chainSlugToId'
import getTransferRootId from 'src/utils/getTransferRootId'
import { BigNumber, providers } from 'ethers'
import { Chain } from 'src/constants'
import { L1_Bridge as L1BridgeContract } from '@hop-protocol/core/contracts/generated/L1_Bridge'
import { L2_Bridge as L2BridgeContract } from '@hop-protocol/core/contracts/generated/L2_Bridge'
import { config as globalConfig } from 'src/config'
import { TransferRoot } from 'src/db/TransferRootsDb'

type Config = {
  chainSlug: string
  tokenSymbol: string
  bridgeContract: L1BridgeContract | L2BridgeContract
  dryMode?: boolean
}

class BondTransferRootWatcher extends BaseWatcher {
  siblingWatchers: { [chainId: string]: BondTransferRootWatcher }

  constructor (config: Config) {
    super({
      chainSlug: config.chainSlug,
      tokenSymbol: config.tokenSymbol,
      logColor: 'cyan',
      bridgeContract: config.bridgeContract,
      dryMode: config.dryMode
    })
  }

  async pollHandler () {
    await this.checkTransfersCommittedFromDb()
  }

  async checkTransfersCommittedFromDb () {
    const dbTransferRoots = await this.db.transferRoots.getUnbondedTransferRoots(await this.getFilterRoute())
    if (!dbTransferRoots.length) {
      this.logger.debug('no unbonded transfer root db items to check')
      return
    }

    this.logger.info(
        `checking ${dbTransferRoots.length} unbonded transfer roots db items`
    )

    const promises: Array<Promise<any>> = []
    for (const dbTransferRoot of dbTransferRoots) {
      const {
        transferRootId,
        transferRootHash,
        totalAmount,
        destinationChainId,
        committedAt,
        sourceChainId,
        transferIds
      } = dbTransferRoot
      const logger = this.logger.create({ root: transferRootId })

      const bondChainId = chainSlugToId(Chain.Ethereum)
      const availableCredit = this.getAvailableCreditForBond(bondChainId)
      const notEnoughCredit = availableCredit.lt(totalAmount)
      if (notEnoughCredit) {
        logger.debug(
        `not enough credit to bond transferRoot. Have ${this.bridge.formatUnits(
          availableCredit
        )}, need ${this.bridge.formatUnits(totalAmount)}`)
        continue
      }

      promises.push(this.checkTransfersCommitted(
        transferRootId,
        transferRootHash,
        totalAmount,
        destinationChainId,
        committedAt,
        sourceChainId,
        transferIds
      ))
    }

    await Promise.all(promises)
  }

  async checkTransfersCommitted (
    transferRootId: string,
    transferRootHash: string,
    totalAmount: BigNumber,
    destinationChainId: number,
    committedAt: number,
    sourceChainId: number,
    transferIds: string[]
  ) {
    const logger = this.logger.create({ root: transferRootId })
    const l1Bridge = this.getSiblingWatcherByChainSlug(Chain.Ethereum).bridge as L1Bridge

    const minDelaySec = await l1Bridge.getMinTransferRootBondDelaySeconds()
    const minDelayMs = minDelaySec * 1000
    const committedAtMs = committedAt * 1000
    const delta = Date.now() - committedAtMs - minDelayMs
    const shouldBond = delta > 0
    if (!shouldBond) {
      logger.debug(
        `too early to bond. Must wait ${Math.abs(
          delta
        )} milliseconds`
      )
      return
    }

    const isBonded = await l1Bridge.isTransferRootIdBonded(transferRootId)
    if (isBonded) {
      logger.warn('checkTransfersCommitted already bonded. marking item not found.')
      await this.db.transferRoots.update(transferRootId, { isNotFound: true })
      return
    }

    logger.info(`source: ${sourceChainId} transferRootId: ${transferRootId} transferRootHash: ${transferRootHash}`)
    logger.debug('committedAt:', committedAt)
    logger.debug('destinationChainId:', destinationChainId)
    logger.debug('sourceChainId:', sourceChainId)
    logger.debug('transferRootId:', transferRootId)
    logger.debug('transferRootHash:', transferRootHash)
    logger.debug('totalAmount:', this.bridge.formatUnits(totalAmount))
    logger.debug('transferRootId:', transferRootId)

    const pendingTransfers: string[] = transferIds || []
    logger.debug('transferRootHash transferIds:', pendingTransfers)
    if (pendingTransfers.length > 0) {
      const tree = new MerkleTree(pendingTransfers)
      const rootHash = tree.getHexRoot()
      logger.debug('calculated transfer root hash:', rootHash)
      if (rootHash !== transferRootHash) {
        logger.error('calculated transfer root hash does not match')
        return
      }
    }

    const bondChainId = chainSlugToId(Chain.Ethereum)
    const bondAmount = await l1Bridge.getBondForTransferAmount(totalAmount)
    const availableCredit = this.getAvailableCreditForBond(bondChainId)
    const notEnoughCredit = availableCredit.lt(bondAmount)
    if (notEnoughCredit) {
      const msg = `not enough credit to bond transferRoot. Have ${this.bridge.formatUnits(
          availableCredit
        )}, need ${this.bridge.formatUnits(bondAmount)}`
      logger.error(msg)
      this.notifier.error(msg)
      return
    }

    if (this.dryMode) {
      logger.warn(`dry: ${this.dryMode}, skipping bondTransferRoot`)
      return
    }

    await this.withdrawFromVaultIfNeeded(destinationChainId, bondAmount)

    logger.debug(
      `attempting to bond transfer root id ${transferRootId} with destination chain ${destinationChainId}`
    )

    await this.db.transferRoots.update(transferRootId, {
      sentBondTxAt: Date.now()
    })

    try {
      const tx = await this.sendBondTransferRoot(
        transferRootHash,
        destinationChainId,
        totalAmount
      )

      const msg = `L1 bondTransferRoot dest ${destinationChainId}, tx ${tx.hash} transferRootHash: ${transferRootHash}`
      logger.info(msg)
      this.notifier.info(msg)
    } catch (err) {
      logger.error('sendBondTransferRoot error:', err.message)
      throw err
    }
  }

  async sendBondTransferRoot (
    transferRootHash: string,
    destinationChainId: number,
    totalAmount: BigNumber
  ): Promise<providers.TransactionResponse> {
    const isValid = await this.isPreTransactionDataValid({
      transferRootHash,
      destinationChainId,
      totalAmount
    })
    if (!isValid) {
      throw new Error('Possible reorg detected. bondTransferRoot tx not sent')
    }

    const l1Bridge = this.getSiblingWatcherByChainSlug(Chain.Ethereum).bridge as L1Bridge
    return l1Bridge.bondTransferRoot(
      transferRootHash,
      destinationChainId,
      totalAmount
    )
  }

  getAvailableCreditForBond (destinationChainId: number) {
    const baseAvailableCredit = this.availableLiquidityWatcher.getBaseAvailableCreditIncludingVault(destinationChainId)
    return baseAvailableCredit
  }

  async withdrawFromVaultIfNeeded (destinationChainId: number, bondAmount: BigNumber) {
    if (!globalConfig.vault[this.tokenSymbol]?.[this.chainIdToSlug(destinationChainId)]?.autoWithdraw) {
      return
    }

    return await this.mutex.runExclusive(async () => {
      const availableCredit = this.getAvailableCreditForBond(destinationChainId)
      const vaultBalance = this.availableLiquidityWatcher.getVaultBalance(destinationChainId)
      const shouldWithdraw = (availableCredit.sub(vaultBalance)).lt(bondAmount)
      this.logger.debug(`availableCredit: ${this.bridge.formatUnits(availableCredit)}, vaultBalance: ${this.bridge.formatUnits(vaultBalance)}, bondAmount: ${this.bridge.formatUnits(bondAmount)}, shouldWithdraw: ${shouldWithdraw}`)
      if (shouldWithdraw) {
        try {
          const msg = `attempting withdrawFromVaultAndStake. amount: ${this.bridge.formatUnits(vaultBalance)}`
          this.notifier.info(msg)
          this.logger.info(msg)
          const destinationWatcher = this.getSiblingWatcherByChainId(destinationChainId)
          await destinationWatcher.withdrawFromVaultAndStake(vaultBalance)
        } catch (err) {
          const errMsg = `withdrawFromVaultAndStake error: ${err.message}`
          this.notifier.error(errMsg)
          this.logger.error(errMsg)
          throw err
        }
      }
    })
  }

  async isPreTransactionDataValid (params: any): Promise<boolean> {
    // Perform this check as late as possible before the transaction is sent
    const {
      transferRootHash,
      destinationChainId,
      totalAmount
    } = params

    // Validate DB existence with calculated transferRootId
    const calculatedTransferRootId = getTransferRootId(transferRootHash, totalAmount)
    const logger = this.logger.create({ root: calculatedTransferRootId })
    const calculatedDbTransferRoot = await this.db.transferRoots.getByTransferRootId(calculatedTransferRootId)
    if (calculatedDbTransferRoot?.transferRootId !== calculatedTransferRootId) {
      logger.error(`Calculated calculatedTransferRootId (${calculatedTransferRootId}) does not match transferRootId in db`)
      return false
    }

    // Validate that the destination chain id matches the db entry
    if (calculatedDbTransferRoot?.destinationChainId !== destinationChainId) {
      logger.error(`destinationChainId (${destinationChainId}) does not match destinationChainId in db (${calculatedDbTransferRoot?.destinationChainId})`)
      return false
    }

    // Validate uniqueness for redundant reorg protection. A transferId should only exist in one transferRoot per source chain
    const transferIds: string[] = calculatedDbTransferRoot.transferIds!.map(x => x.toLowerCase())
    const dbTransferIds: string[] = []
    const dbTransferRoots: TransferRoot[] = await this.db.transferRoots.getTransferRootsFromTwoWeeks()
    for (const dbTransferRoot of dbTransferRoots) {
      if (dbTransferRoot.sourceChainId !== this.bridge.chainId) continue
      for (const transferId of dbTransferRoot.transferIds!) {
        dbTransferIds.push(transferId.toLowerCase())
      }
    }

    const areTransferIdsUnique = transferIds.every(transferId => {
      const numOccurrences = dbTransferIds.filter(dbTransferId => dbTransferId === transferId).length
      return numOccurrences === 1
    })
    if (!areTransferIdsUnique) {
      logger.error(`transferIds (${transferIds}) are either not unique and exist in multiple transferRoots or do not exist in any root`)
      return false
    }

    return true
  }
}

export default BondTransferRootWatcher
