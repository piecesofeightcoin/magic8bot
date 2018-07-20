import 'colors'

import { timebucket } from '../util/timebucket'
import { EventEmitter } from 'events'
import async from 'async'
import n from 'numbro'
import _ from 'lodash'
import moment from 'moment'
import lolex from 'lolex'

import { loadStrategy } from '../plugins/strategies'
import notify from '../util/notify'

import { formatAsset, formatPercent, formatCurrency } from '../util/format'

import { Report } from './report'
import { Quote } from './quote'
import { Exchange } from './exchange'

import * as debug from './debug'
import { asyncTimeout } from '../util/async'
import { EngineConf } from '@m8bTypes'
import { Selector } from '../util'

enum ORDER_STATUS {
  LIVE,
  CANCELED,
  FAILED,
  PARTIAL,
  DONE,
}

interface Error {
  desc?: string
  code?: string
  body?: string
}

export class Core {
  public tradeProcessingQueue: any

  private eventBus: EventEmitter
  private notifier: {
    pushMessage: (title: string, message: string) => void
  }

  private clock: any

  private report: Report

  private product
  private balance
  private isPreroll: boolean = true

  constructor(private exchange: Exchange, private strategy, private selector: Selector, private conf: EngineConf) {
    this.conf.asset_capital = 0

    if (typeof this.conf.period_length == 'undefined') this.conf.period_length = this.conf.period
    else this.conf.period = this.conf.period_length

    this.product = this.exchange
      .getProducts()
      .find((product) => product.asset === this.selector.asset && product.currency === this.selector.currency)

    if (!this.product) throw new Error(`Error: Could not find product "${this.selector.product_id}"`)

    if (this.exchange.dynamicFees)
      this.exchange.setFees({ asset: this.selector.asset, currency: this.selector.currency })

    if (this.conf.mode === 'sim' || this.conf.mode === 'paper') {
      this.balance = { asset: this.conf.asset_capital, currency: this.conf.currency_capital, deposit: 0 }
    } else {
      this.balance = { asset: 0, currency: 0, deposit: 0 }
    }

    // const ctx = {
    //   option: (name, desc, type, def) => {
    //     if (typeof this.conf[name] === 'undefined') {
    //       this.conf[name] = def
    //     }
    //   },
    // }

    // this.s.lookback = []
    // this.s.day_count = 1
    // this.s.my_trades = []
    // this.s.my_prev_trades = []
    // this.s.vol_since_last_blink = 0

    // if (conf.output.api.on) {
    //   this.s.boot_time = new Date().getTime()
    //   this.s.tz_offset = new Date().getTimezoneOffset()
    //   this.s.last_trade_id = 0
    //   this.s.trades = []
    // }

    // if (this.strategy.getOptions) {
    //   this.strategy.getOptions.call(ctx, s)
    // }

    this.notifier = notify(conf)

    this.tradeProcessingQueue = async.queue(({ trade, isPreroll }, callback) => {
      this.onTrade(trade, isPreroll, callback)
    })

    this.report = new Report()
  }

  queueTrade = (trade, isPreroll) => {
    this.tradeProcessingQueue.push({ trade, isPreroll })
  }

  onTrade = (trade, isPreroll, cb) => {
    // if (this.s.period && trade.time < this.s.period.time) return
    // if (!this.s.period) this.initBuffer(trade)
    // this.isPreroll = isPreroll
    // if (trade.time > this.s.period.close_time) {
    //   const period_id = tb(trade.time)
    //     .resize(this.conf.period_length)
    //     .toString()
    //   this.strategy.onPeriod.call(this.s.ctx, this.s, () => {
    //     this.writeReport()
    //     this.s.acted_on_stop = false
    //     if (!this.isPreroll && !this.conf.manual) {
    //       this.executeStop(true)
    //       if (this.s.signal) this.executeSignal(this.s.signal)
    //     }
    //     this.s.lookback.unshift(this.s.period)
    //     this.s.action = null
    //     this.s.signal = null
    //     this.initBuffer(trade)
    //     this.withOnPeriod(trade, period_id, cb)
    //   })
    // } else {
    //   this.withOnPeriod(trade, null, cb)
    // }
  }

  onTrades = (trades, isPreroll, cb?) => {
    if (typeof isPreroll === 'function') {
      cb = isPreroll
      isPreroll = false
    }

    trades.sort(({ time: a }, { time: b }) => (a === b ? 0 : a < b ? -1 : 1))

    trades.slice(0).forEach((trade) => this.queueTrade(trade, isPreroll))

    if (typeof cb === 'function') cb()
  }

  writeReport = (isProgress?: boolean, blinkOff?: boolean) => {
    this.report.writeReport(this.s, isProgress, blinkOff)
  }

  syncBalance = async () => {
    const preAsset = this.conf.mode === 'sim' ? this.s.sim_asset : this.balance.asset

    const balance = await this.getBalance()
    this.balance = balance

    const quote = await Quote.getQuote(this.exchange, this.selector.product_id)

    const diffAsset = n(preAsset).subtract(balance.asset)
    const postCurrency = n(diffAsset).multiply(quote.ask)

    this.s.asset_capital = n(this.balance.asset)
      .multiply(quote.ask)
      .value()

    // prettier-ignore
    const deposit = this.conf.deposit
        // @ts-ignore
        ? Math.max(0, n(this.conf.deposit).subtract(this.s.asset_capital))
        : this.balance.currency // zero on negative

    this.balance.deposit = n(deposit < this.balance.currency ? deposit : this.balance.currency).value()

    if (!this.s.start_capital) {
      this.s.start_price = n(quote.ask).value()
      this.s.start_capital = n(this.balance.deposit)
        .add(this.s.asset_capital)
        .value()
      this.s.real_capital = n(this.balance.currency)
        .add(this.s.asset_capital)
        .value()
      this.s.net_currency = this.balance.deposit

      if (this.conf.mode !== 'sim') {
        this.pushMessage(
          'Balance ' + this.exchange.name.toUpperCase(),
          'sync balance ' + this.s.real_capital + ' ' + this.selector.currency + '\n'
        )
      }
    } else {
      this.s.net_currency = n(this.s.net_currency)
        .add(postCurrency)
        .value()
    }

    return { balance, quote }
  }

  async getBalance() {
    const opts = { currency: this.selector.currency, asset: this.selector.asset }
    return this.exchange.getBalance(opts)
  }

  executeSignal = async (signal, initSize?, isReorder?, isTaker?) => {
    delete this.s[(signal === 'buy' ? 'sell' : 'buy') + '_order']

    this.s.last_signal = signal
    if (!isReorder && this.s[signal + '_order']) {
      if (isTaker) this.s[signal + '_order'].order_type = 'taker'
      // order already placed
      return
    }

    try {
      const { quote } = await this.syncBalance()

      const { reorderPercent, size } = this.getReorderPercent(isReorder, signal, initSize)

      let trades
      if (this.s.my_prev_trades.length) {
        trades = [...this.s.my_prev_trades, ...this.s.my_trades]
      } else {
        trades = JSON.parse(JSON.stringify(this.s.my_trades))
      }

      if (signal === 'buy') {
        await this.executeBuy(quote, isReorder, reorderPercent, size, trades, isTaker)
        delete this.s.buy_order
      } else if (signal === 'sell') {
        await this.executeSell(quote, isReorder, reorderPercent, trades, isTaker)
        delete this.s.sell_order
      }
    } catch (err) {
      console.log(err)
    }
  }

  private getReorderPercent(isReorder: any, signal: any, size: any) {
    let reorderPercent
    if (isReorder && this.s[signal + '_order']) {
      if (signal === 'buy') {
        reorderPercent = n(size)
          .multiply(this.s.buy_order.price)
          .add(this.s.buy_order.fee)
          .divide(this.balance.deposit)
          .multiply(100)
      } else {
        reorderPercent = n(size)
          .divide(this.balance.asset)
          .multiply(100)
      }
      debug.msg('price changed, resizing order, ' + reorderPercent + '% remain')
      size = null
    }

    return { reorderPercent, size }
  }

  async executeBuy(quote, isReorder, reorderPercent, initSize, trades, isTaker) {
    const price = Quote.nextBuyForQuote(quote, this.product.increment, this.conf.markdown_buy_pct)
    const bidPercent = this.getBidPercent(isReorder, reorderPercent)
    const fee = this.getBidFee(bidPercent)
    const { tradeBalance, tradeableBalance } = this.getTradableBalance(bidPercent, fee)
    const expectedFee = this.getExpectedFee(tradeBalance, tradeableBalance)
    const size = this.getBidSize(bidPercent, fee, initSize, tradeableBalance, price, tradeBalance, expectedFee)

    const isSizeAboveMin = this.product.min_size && Number(size) >= Number(this.product.min_size)
    const isSizeAboveTotal =
      'min_total' in this.product &&
      this.product.min_total &&
      n(size)
        .multiply(price)
        .value() >= Number(this.product.min_total)

    if (!(isSizeAboveMin || isSizeAboveTotal)) return false

    const finalSize = this.adjustBidSize(size)

    const assetSize = formatAsset(finalSize, this.selector.asset)
    const currencySize = formatCurrency(tradeableBalance, this.selector.currency)
    const feeAmt = formatCurrency(expectedFee, this.selector.currency)
    const buyPrice = formatCurrency(price, this.selector.currency)

    debug.msg(
      `preparing buy order over ${assetSize} of ${currencySize} (${bidPercent}%) tradeable balance with a expected fee of ${feeAmt} (${fee}%)`
    )

    this.checkBidOrder(trades, price)

    // prettier-ignore
    const shouldDelay = n(this.balance.deposit).subtract(this.balance.currency_hold || 0).value() < n(price).multiply(finalSize).value()
    && this.balance.currency_hold > 0

    if (shouldDelay) {
      // prettier-ignore
      const depositPercent = formatPercent(n(this.balance.currency_hold || 0).divide(this.balance.deposit).value())
      const currencyHold = formatCurrency(this.balance.currency_hold, this.selector.currency)

      debug.msg(`buy delayed: ${depositPercent} of funds (${currencyHold}) on hold'`)

      if (this.s.last_signal === 'buy')
        return asyncTimeout(() => this.executeSignal('buy', finalSize, true), this.conf.wait_for_settlement)
      else throw new Error('Signal changed!')
    }

    const priceUnder = formatCurrency(quote.bid - Number(price), this.selector.currency)
    const title = `Buying ${assetSize} on ${this.exchange.name}`
    const message = `placing buy order at ${buyPrice}, ${priceUnder} under best bid\n`
    this.pushMessage(title, message)

    return this.doOrder('buy', finalSize, price, expectedFee, isTaker)
  }

  private checkBidOrder(trades: any, price: string) {
    // return lowest price
    const latestLowSell = _
      .chain(trades)
      .dropRightWhile(['type', 'buy'])
      .takeRightWhile(['type', 'sell'])
      .sortBy(['price'])
      .head()
      .value()

    const buyLoss = latestLowSell ? ((latestLowSell.price - Number(price)) / latestLowSell.price) * -100 : null

    if (this.conf.max_buy_loss_pct != null && buyLoss > this.conf.max_buy_loss_pct) {
      const err = new Error('\nloss protection') as Error
      // const buyLossPercent = formatPercent(buyLoss / 100)
      // err.desc = `refusing to buy at ${buyPrice}, buy loss of ${buyLossPercent}`
      throw err
    }

    if (this.s.buy_order && this.conf.max_slippage_pct != null) {
      const slippage = n(price)
        .subtract(this.s.buy_order.orig_price)
        .divide(this.s.buy_order.orig_price)
        .multiply(100)
        .value()

      if (this.conf.max_slippage_pct != null && slippage > this.conf.max_slippage_pct) {
        const err = new Error('\nslippage protection') as Error
        // const slippagePercent = formatPercent(slippage / 100)
        // err.desc = `refusing to buy at ${buyPrice}, slippage of ${slippagePercent}`
        throw err
      }
    }
  }

  private adjustBidSize(size: any) {
    if (this.product.max_size && Number(size) > Number(this.product.max_size)) {
      size = this.product.max_size
    }
    return size
  }

  private getBidSize(
    bidPercent: any,
    fee: any,
    size: any,
    tradeableBalance: any,
    price: string,
    tradeBalance: any,
    expectedFee: any
  ) {
    if (bidPercent + fee < 100) {
      size = n(tradeableBalance)
        .divide(price)
        .format(this.product.asset_increment ? this.product.asset_increment : '0.00000000')
    } else {
      size = n(tradeBalance)
        .subtract(expectedFee)
        .divide(price)
        .format(this.product.asset_increment ? this.product.asset_increment : '0.00000000')
    }
    return size
  }

  private getExpectedFee(tradeBalance: any, tradeableBalance: any) {
    let expected_fee
    // @ts-ignore
    expected_fee = n(tradeBalance)
      .subtract(tradeableBalance)
      .format('0.00000000', Math.ceil) // round up as the exchange will too
    return expected_fee
  }

  private getTradableBalance(bidPercent: any, fee: any) {
    const tradeBalance = n(this.balance.deposit)
      .divide(100)
      .multiply(bidPercent)
    const tradeableBalance = n(this.balance.deposit)
      .divide(100 + fee)
      .multiply(bidPercent)
    return { tradeBalance, tradeableBalance }
  }

  private getBidFee(bidPercent: any) {
    let fee
    if (this.conf.use_fee_asset) {
      fee = 0
    } else if (
      this.conf.order_type === 'maker' &&
      (bidPercent + this.exchange.takerFee < 100 || !this.exchange.makerBuy100Workaround)
    ) {
      fee = this.exchange.makerFee
    } else {
      fee = this.exchange.takerFee
    }
    return fee
  }

  private getBidPercent(isReorder: any, reorderPercent: any) {
    let bidPercent
    if (isReorder) {
      bidPercent = reorderPercent
    } else {
      bidPercent = this.conf.buy_pct
    }
    return bidPercent
  }

  async executeSell(quote, isReorder, reorderPercent, trades, isTaker) {
    const price = Quote.nextSellForQuote(quote, this.product.increment, this.conf.markup_sell_pct)
    const askPercent = this.getAskPercent(isReorder, reorderPercent)

    const initSize = n(this.balance.asset)
      .multiply(askPercent / 100)
      .format(this.product.asset_increment ? this.product.asset_increment : '0.00000000')

    const isSizeAboveMin = this.product.min_size && Number(initSize) >= Number(this.product.min_size)
    const isSizeAboveTotal =
      'min_total' in this.product &&
      this.product.min_total &&
      n(initSize)
        .multiply(price)
        .value() >= Number(this.product.min_total)

    if (!(isSizeAboveMin || isSizeAboveTotal)) return false

    const size = this.adjustAskSize(initSize)

    const sellPrice = formatCurrency(price, this.selector.currency)

    this.checkAskOrder(trades, price, sellPrice)

    // prettier-ignore
    const shouldDelay = n(this.balance.asset).subtract(this.balance.asset_hold || 0).value() < n(size).value()

    if (shouldDelay) {
      // prettier-ignore
      const assetPercent = formatPercent(n(this.balance.asset_hold || 0).divide(this.balance.asset).value())
      const assetHold = formatAsset(this.balance.asset_hold, this.selector.asset)

      debug.msg(`sell delayed: ${assetPercent} of funds (${assetHold}) on hold'`)

      if (this.s.last_signal === 'sell')
        return asyncTimeout(() => this.executeSignal('sell', this.adjustAskSize, true), this.conf.wait_for_settlement)
      else throw new Error('Signal changed!')
    }

    const assetSize = formatAsset(size, this.selector.asset)
    const priceUnder = formatCurrency(Number(price) - quote.bid, this.selector.currency)
    const title = `Selling ${assetSize} on ${this.exchange.name}`
    const message = `placing sell order at ${sellPrice}, ${priceUnder} under best ask\n`
    this.pushMessage(title, message)

    return this.doOrder('sell', size, price, null, isTaker)
  }

  private checkAskOrder(trades: any, price: string, sellPrice: string) {
    // return highest price
    const latestHighBuy = _
      .chain(trades)
      .dropRightWhile(['type', 'sell'])
      .takeRightWhile(['type', 'buy'])
      .sortBy(['price'])
      .reverse()
      .head()
      .value()

    const sellLoss = latestHighBuy ? ((Number(price) - latestHighBuy.price) / latestHighBuy.price) * -100 : null

    if (this.conf.max_sell_loss_pct != null && sellLoss > this.conf.max_sell_loss_pct) {
      const err = new Error('\nloss protection') as Error
      // const sellLossPercent = formatPercent(sellLoss / 100)
      // err.desc = `refusing to sell at ${sellPrice}, sell loss of ${sellLossPercent}`
      throw err
    }

    if (this.s.sell_order && this.conf.max_slippage_pct != null) {
      const slippage = n(this.s.sell_order.orig_price)
        .subtract(price)
        .divide(price)
        .multiply(100)
        .value()

      if (slippage > this.conf.max_slippage_pct) {
        const err = new Error('\nslippage protection') as Error
        // const slippagePercent = formatPercent(slippage / 100)
        // err.desc = `refusing to sell at ${sellPrice}, slippage of ${slippagePercent}`
        throw err
      }
    }
  }

  private adjustAskSize(size: string) {
    if (this.product.max_size && Number(size) > Number(this.product.max_size)) {
      size = this.product.max_size
    }
    return size
  }

  private getAskPercent(isReorder: any, reorderPercent: any) {
    return isReorder ? reorderPercent : this.conf.sell_pct
  }

  async doOrder(signal: any, size: any, price: any, expected_fee: any, is_taker: any) {
    const order = {
      size: size,
      price: price,
      fee: expected_fee || null,
      is_taker: is_taker,
      cancel_after: this.conf.cancel_after || 'day',
    }

    return this.placeOrder(signal, order)
  }

  memDump() {
    if (!debug.on) return
    const clone = JSON.parse(JSON.stringify(this.s))
    delete clone.options.mongo
    delete clone.lookback

    console.error(clone)
  }

  pushMessage(title, message) {
    const { mode } = this.conf
    if (mode === 'live' || mode === 'paper') this.notifier.pushMessage(title, message)
  }

  initBuffer(trade) {
    const d = timebucket(trade.time).resize(this.conf.period_length)
    const de = timebucket(trade.time)
      .resize(this.conf.period_length)
      .add(1)

    this.s.period = {
      period_id: d.toString(),
      size: this.conf.period_length,
      time: d.toMilliseconds(),
      open: trade.price,
      high: trade.price,
      low: trade.price,
      close: trade.price,
      volume: 0,
      close_time: de.toMilliseconds() - 1,
    }
  }

  updatePeriod(trade) {
    this.s.period.high = Math.max(trade.price, this.s.period.high)
    this.s.period.low = Math.min(trade.price, this.s.period.low)
    this.s.period.close = trade.price
    this.s.period.volume += trade.size
    this.s.period.latest_trade_time = trade.time

    this.strategy.calculate(this.s)
    this.s.vol_since_last_blink += trade.size

    if (this.s.trades && this.s.last_trade_id !== trade.trade_id) {
      this.s.trades.push(trade)
      this.s.last_trade_id = trade.trade_id
    }
  }

  executeStop(do_sell_stop?) {
    let stop_signal
    if (this.s.my_trades.length || this.s.my_prev_trades.length) {
      var last_trade
      if (this.s.my_trades.length) {
        last_trade = this.s.my_trades[this.s.my_trades.length - 1]
      } else {
        last_trade = this.s.my_prev_trades[this.s.my_prev_trades.length - 1]
      }
      this.s.last_trade_worth =
        last_trade.type === 'buy'
          ? (this.s.period.close - last_trade.price) / last_trade.price
          : (last_trade.price - this.s.period.close) / last_trade.price
      if (!this.s.acted_on_stop) {
        if (last_trade.type === 'buy') {
          if (do_sell_stop && this.s.sell_stop && this.s.period.close < this.s.sell_stop) {
            stop_signal = 'sell'
            console.log(('\nsell stop triggered at ' + formatPercent(this.s.last_trade_worth) + ' trade worth\n').red)
          } else if (
            this.conf.profit_stop_enable_pct &&
            this.s.last_trade_worth >= this.conf.profit_stop_enable_pct / 100
          ) {
            this.s.profit_stop_high = Math.max(this.s.profit_stop_high || this.s.period.close, this.s.period.close)
            this.s.profit_stop = this.s.profit_stop_high - this.s.profit_stop_high * (this.conf.profit_stop_pct / 100)
          }
          if (this.s.profit_stop && this.s.period.close < this.s.profit_stop && this.s.last_trade_worth > 0) {
            stop_signal = 'sell'
            console.log(
              ('\nprofit stop triggered at ' + formatPercent(this.s.last_trade_worth) + ' trade worth\n').green
            )
          }
        } else {
          if (this.s.buy_stop && this.s.period.close > this.s.buy_stop) {
            stop_signal = 'buy'
            console.log(('\nbuy stop triggered at ' + formatPercent(this.s.last_trade_worth) + ' trade worth\n').red)
          }
        }
      }
    }
    if (stop_signal) {
      this.s.signal = stop_signal
      this.s.acted_on_stop = true
    }
  }

  async placeOrder(type, opts) {
    if (!this.s[type + '_order']) {
      this.s[type + '_order'] = {
        price: opts.price,
        size: opts.size,
        fee: opts.fee,
        orig_size: opts.size,
        remaining_size: opts.size,
        orig_price: opts.price,
        order_type: opts.is_taker ? 'taker' : this.conf.order_type,
        cancel_after: this.conf.cancel_after || 'day',
        is_taker: opts.is_taker,
      }
    }

    const order = this.s[type + '_order']
    order.price = opts.price
    order.size = opts.size
    order.fee = opts.fee
    order.remaining_size = opts.size

    order.product_id = this.selector.product_id
    order.post_only = this.conf.post_only

    debug.msg('placing ' + type + ' order...')

    const orderCopy = JSON.parse(JSON.stringify(order))

    const api_order = await this.exchange.placeOrder(type, orderCopy)

    if (api_order.status === 'rejected') {
      if (api_order.reject_reason === 'post only') {
        // trigger immediate price adjustment and re-order
        debug.msg('post-only ' + type + ' failed, re-ordering')
        return null
      } else if (api_order.reject_reason === 'balance') {
        // treat as a no-op.
        debug.msg('not enough balance for ' + type + ', aborting')
        return false
      } else if (api_order.reject_reason === 'price') {
        // treat as a no-op.
        debug.msg('invalid price for ' + type + ', aborting')
        return false
      }
      const err = new Error('\norder rejected') as any
      err.order = api_order
      throw err
    }

    // @ts-ignore
    debug.msg(type + ' order placed at ' + formatCurrency(order.price, this.selector.currency))
    order.order_id = api_order.id
    if (!order.time) {
      order.orig_time = new Date(api_order.created_at).getTime()
    }
    order.time = new Date(api_order.created_at).getTime()
    order.local_time = this.now()
    order.status = api_order.status

    return await asyncTimeout(() => this.checkOrder(order, type), this.conf.order_poll_time)
  }

  completeOrder(trade, type) {
    let price,
      fee = 0
    if (!this.conf.order_type) {
      this.conf.order_type = 'maker'
    }

    // If order is cancelled, but on the exchange it completed, we need to recover it here
    if (type === 'buy') this.s.buy_order = trade
    else if (type === 'sell') this.s.sell_order = trade

    if (this.s.buy_order) {
      price = this.s.buy_order.price
      if (this.conf.order_type === 'maker') {
        if (this.exchange.makerFee) {
          fee = n(this.s.buy_order.size)
            .multiply(this.exchange.makerFee / 100)
            .value()
        }
      }
      if (this.conf.order_type === 'taker') {
        if (this.exchange.takerFee) {
          fee = n(this.s.buy_order.size)
            .multiply(this.exchange.takerFee / 100)
            .value()
        }
      }
      this.s.action = 'bought'
      if (!this.s.last_sell_price && this.s.my_prev_trades.length) {
        let prev_sells = this.s.my_prev_trades.filter((trade) => trade.type === 'sell')
        if (prev_sells.length) {
          this.s.last_sell_price = prev_sells[prev_sells.length - 1].price
        }
      }
      let my_trade = {
        order_id: trade.order_id,
        time: trade.time,
        execution_time: trade.time - this.s.buy_order.orig_time,
        slippage: n(price)
          .subtract(this.s.buy_order.orig_price)
          .divide(this.s.buy_order.orig_price)
          .value(),
        type: 'buy',
        size: this.s.buy_order.orig_size,
        fee: fee,
        price: price,
        order_type: this.conf.order_type || 'taker',
        profit: this.s.last_sell_price && (this.s.last_sell_price - price) / this.s.last_sell_price,
        cancel_after: this.conf.cancel_after || 'day',
      }
      this.s.my_trades.push(my_trade)
      if (this.conf.stats) {
        let order_complete =
          '\nbuy order completed at ' +
          moment(trade.time).format('YYYY-MM-DD HH:mm:ss') +
          ':\n\n' +
          formatAsset(my_trade.size, this.selector.asset) +
          ' at ' +
          // @ts-ignore
          formatCurrency(my_trade.price, this.selector.currency) +
          '\ntotal ' +
          // @ts-ignore
          formatCurrency(my_trade.size * my_trade.price, this.selector.currency) +
          '\n' +
          n(my_trade.slippage).format('0.0000%') +
          ' slippage (orig. price ' +
          // @ts-ignore
          formatCurrency(this.s.buy_order.orig_price, this.selector.currency) +
          ')\nexecution: ' +
          moment.duration(my_trade.execution_time).humanize() +
          '\n'
        console.log(order_complete.cyan)
        this.pushMessage('Buy ' + this.exchange.name, order_complete)
      }
      this.s.last_buy_price = my_trade.price
      delete this.s.buy_order
      delete this.s.buy_stop
      delete this.s.sell_stop
      if (this.conf.sell_stop_pct) {
        this.s.sell_stop = n(price)
          .subtract(n(price).multiply(this.conf.sell_stop_pct / 100))
          .value()
      }
      delete this.s.profit_stop
      delete this.s.profit_stop_high
      // this.eventBus.emit('orderExecuted', 'buy')
    } else if (this.s.sell_order) {
      price = this.s.sell_order.price
      if (this.conf.order_type === 'maker') {
        if (this.exchange.makerFee) {
          fee = n(this.s.sell_order.size)
            .multiply(this.exchange.makerFee / 100)
            .multiply(price)
            .value()
        }
      }
      if (this.conf.order_type === 'taker') {
        if (this.exchange.takerFee) {
          fee = n(this.s.sell_order.size)
            .multiply(this.exchange.takerFee / 100)
            .multiply(price)
            .value()
        }
      }
      this.s.action = 'sold'
      if (!this.s.last_buy_price && this.s.my_prev_trades.length) {
        let prev_buys = this.s.my_prev_trades.filter((trade) => trade.type === 'buy')
        if (prev_buys.length) {
          this.s.last_buy_price = prev_buys[prev_buys.length - 1].price
        }
      }
      let my_trade = {
        order_id: trade.order_id,
        time: trade.time,
        execution_time: trade.time - this.s.sell_order.orig_time,
        slippage: n(this.s.sell_order.orig_price)
          .subtract(price)
          .divide(price)
          .value(),
        type: 'sell',
        size: this.s.sell_order.orig_size,
        fee: fee,
        price: price,
        order_type: this.conf.order_type,
        profit: this.s.last_buy_price && (price - this.s.last_buy_price) / this.s.last_buy_price,
      }
      this.s.my_trades.push(my_trade)
      if (this.conf.stats) {
        let order_complete =
          '\nsell order completed at ' +
          moment(trade.time).format('YYYY-MM-DD HH:mm:ss') +
          ':\n\n' +
          formatAsset(my_trade.size, this.selector.asset) +
          ' at ' +
          // @ts-ignore
          formatCurrency(my_trade.price, this.selector.currency) +
          '\ntotal ' +
          // @ts-ignore
          formatCurrency(my_trade.size * my_trade.price, this.selector.currency) +
          '\n' +
          n(my_trade.slippage).format('0.0000%') +
          ' slippage (orig. price ' +
          // @ts-ignore
          formatCurrency(this.s.sell_order.orig_price, this.selector.currency) +
          ')\nexecution: ' +
          moment.duration(my_trade.execution_time).humanize() +
          '\n'
        console.log(order_complete.cyan)
        this.pushMessage('Sell ' + this.exchange.name, order_complete)
      }
      this.s.last_sell_price = my_trade.price
      delete this.s.sell_order
      delete this.s.buy_stop
      if (this.conf.buy_stop_pct) {
        this.s.buy_stop = n(price)
          .add(n(price).multiply(this.conf.buy_stop_pct / 100))
          .value()
      }
      delete this.s.sell_stop
      delete this.s.profit_stop
      delete this.s.profit_stop_high
      // this.eventBus.emit('orderExecuted', 'sell')
    }
  }

  now() {
    return new Date().getTime()
  }

  withOnPeriod(trade, period_id, cb) {
    if (!this.clock && this.conf.mode !== 'live' && this.conf.mode !== 'paper')
      this.clock = lolex.install({ shouldAdvanceTime: false, now: trade.time })

    this.updatePeriod(trade)
    if (!this.isPreroll) {
      if (this.conf.mode !== 'live') this.s.exchange.processTrade(trade)

      if (!this.conf.manual) {
        this.executeStop()

        if (this.clock) {
          var diff = trade.time - this.now()

          // Allow some catch-up if trades are too far apart. Don't want all calls happening at the same time
          while (diff > 5000) {
            this.clock.tick(5000)
            diff -= 5000
          }
          this.clock.tick(diff)
        }

        if (this.s.signal) {
          this.executeSignal(this.s.signal)
          this.s.signal = null
        }
      }
    }
    this.s.last_period_id = period_id
    cb()
  }

  async cancelOrder(order, type) {
    const opts = { order_id: order.order_id, product_id: this.selector.product_id }
    await this.exchange.cancelOrder(opts)
    return await this.checkHold(order, type)
  }

  async checkHold(order, type) {
    const opts = { order_id: order.order_id, product_id: this.selector.product_id }

    const api_order = await this.exchange.getOrder(opts)

    if (!api_order) return ORDER_STATUS.FAILED

    if (api_order) {
      if (api_order.status === 'done') {
        order.time = new Date(api_order.done_at).getTime()
        // Use actual price if possible. In market order the actual price (api_order.price) could be very different from trade price
        order.price = api_order.price || order.price
        debug.msg('cancel failed, order done, executing')
        this.completeOrder(order, type)

        await this.syncBalance()
        return ORDER_STATUS.DONE
      }

      if (api_order.filled_size) {
        order.remaining_size = n(order.size)
          .subtract(api_order.filled_size)
          .format(this.product.asset_increment ? this.product.asset_increment : '0.00000000')
      }
    }

    await this.syncBalance()

    const on_hold =
      type === 'buy'
        ? n(this.balance.deposit)
            .subtract(this.balance.currency_hold || 0)
            .value() <
          n(order.price)
            .multiply(order.remaining_size)
            .value()
        : n(this.balance.asset)
            .subtract(this.balance.asset_hold || 0)
            .value() < n(order.remaining_size).value()

    if (!on_hold || this.balance.currency_hold <= 0) return ORDER_STATUS.CANCELED

    debug.msg('funds on hold after cancel, waiting 5s')
    return await asyncTimeout(() => this.checkHold(order, type), this.conf.wait_for_settlement)
  }

  async checkOrder(order, type) {
    if (!this.s[type + '_order']) {
      // signal switched, stop checking order
      debug.msg('signal switched during ' + type + ', aborting')
      return this.cancelOrder(order, type)
    }

    const opts = { order_id: order.order_id, product_id: this.selector.product_id }
    const api_order = await this.exchange.getOrder(opts)

    order.status = api_order.status
    if (api_order.reject_reason) order.reject_reason = api_order.reject_reason

    if (api_order.status === 'done') {
      order.time = new Date(api_order.done_at).getTime()
      // Use actual price if possible. In market order the actual price (api_order.price) could be very different from trade price
      order.price = api_order.price || order.price
      this.completeOrder(order, type)

      await this.syncBalance()
      return order
    }

    const postFailed =
      order.status === 'rejected' && (order.reject_reason === 'post only' || api_order.reject_reason === 'post only')

    if (postFailed) {
      debug.msg(`post-only ${type} failed, re-ordering`)
      return null
    }

    if (order.status === 'rejected' && order.reject_reason === 'balance') {
      debug.msg(`not enough balance for ${type}, aborting`)
      return null
    }

    const shouldAdjustOrder = this.now() - order.local_time >= this.conf.order_adjust_time
    if (!shouldAdjustOrder) return asyncTimeout(() => this.checkOrder(order, type), this.conf.order_poll_time)

    const quote = await Quote.getQuote(this.exchange, this.selector.product_id)

    const markedPrice =
      type === 'buy'
        ? Quote.nextBuyForQuote(quote, this.product.increment, this.conf.markdown_buy_pct)
        : Quote.nextSellForQuote(quote, this.product.increment, this.conf.markup_sell_pct)

    const priceMismatch = this.conf[`exact_${type}_orders`] && n(order.price).value() != markedPrice
    const priceSlipped = type === 'buy' ? n(order.price).value() < markedPrice : n(order.price).value() > markedPrice

    if (priceMismatch) debug.msg(`${markedPrice} vs! our ${order.price}`)
    if (priceSlipped) debug.msg(`${markedPrice} vs our ${order.price}`)

    if (priceMismatch || priceSlipped) {
      await this.cancelOrder(order, type)
      return this.executeSignal(type, order.size, true, order.is_taker)
    }

    order.local_time = this.now()
    return asyncTimeout(() => this.checkOrder(order, type), this.conf.order_poll_time)
  }

  // FOR DEBUGGING / TESTING

  setSignal = (signal: 'buy' | 'sell') => {
    this.s.signal = signal
  }
}