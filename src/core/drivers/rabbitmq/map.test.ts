import { describe, expect, it } from 'vitest'
import {
  fromProperties,
  toBinding,
  toOverview,
  toPeeked,
  toProperties,
  toQueue,
  toQueueDetail,
  toUser,
  toVhost,
} from './map'

describe('toQueue', () => {
  it('reads what the list gives and defaults what it leaves out', () => {
    expect(
      toQueue({
        name: 'orders',
        vhost: '/',
        type: 'quorum',
        durable: true,
        state: 'running',
        messages: 7,
        messages_ready: 5,
        messages_unacknowledged: 2,
        consumers: 3,
        policy: 'ha',
        message_stats: { publish_details: { rate: 1.5 }, deliver_get_details: { rate: 0.5 } },
      }),
    ).toEqual({
      name: 'orders',
      vhost: '/',
      type: 'quorum',
      durable: true,
      autoDelete: false,
      exclusive: false,
      state: 'running',
      messages: 7,
      ready: 5,
      unacked: 2,
      consumers: 3,
      rateIn: 1.5,
      rateOut: 0.5,
      policy: 'ha',
    })
    expect(toQueue({ name: 'fresh' }, 'v')).toMatchObject({
      vhost: 'v',
      type: 'classic',
      messages: 0,
      ready: 0,
      rateIn: 0,
      policy: null,
    })
  })

  it('takes the type from the arguments of an older broker', () => {
    expect(toQueue({ name: 'q', arguments: { 'x-queue-type': 'stream' } }).type).toBe('stream')
  })

  it('does not believe a number that is not one', () => {
    expect(toQueue({ name: 'q', messages: 'many', consumers: NaN }).messages).toBe(0)
  })
})

describe('toQueueDetail', () => {
  it('adds the bindings, the consumers and the members', () => {
    const detail = toQueueDetail(
      {
        name: 'q',
        vhost: '/',
        arguments: { 'x-max-length': 10 },
        node: 'rabbit@a',
        idle_since: '2026-01-01 00:00:00',
        memory: 1234,
        members: ['rabbit@a', 'rabbit@b'],
        leader: 'rabbit@a',
        consumer_details: [
          {
            consumer_tag: 'c1',
            channel_details: { name: 'ch' },
            ack_required: true,
            prefetch_count: 20,
            active: true,
          },
        ],
      },
      [
        {
          source: 'ex',
          vhost: '/',
          destination: 'q',
          destination_type: 'queue',
          routing_key: 'k',
          arguments: {},
          properties_key: 'k',
        },
      ],
    )
    expect(detail).toMatchObject({
      arguments: { 'x-max-length': 10 },
      node: 'rabbit@a',
      memory: 1234,
      members: ['rabbit@a', 'rabbit@b'],
      leader: 'rabbit@a',
      consumerDetails: [
        { tag: 'c1', channel: 'ch', ackRequired: true, prefetch: 20, active: true },
      ],
      bindings: [{ source: 'ex', routingKey: 'k', destinationType: 'queue' }],
    })
  })
})

describe('toBinding', () => {
  it('knows a binding to an exchange from one to a queue, and gives an empty key a name', () => {
    expect(
      toBinding({ source: 'a', destination: 'b', destination_type: 'exchange' }),
    ).toMatchObject({
      destinationType: 'exchange',
      routingKey: '',
      propertiesKey: '~',
    })
  })
})

describe('toUser and toVhost', () => {
  it('reads tags as a list or as the comma-separated text of an older broker', () => {
    expect(toUser({ name: 'a', tags: ['management', 'monitoring'] }).tags).toEqual([
      'management',
      'monitoring',
    ])
    expect(toUser({ name: 'a', tags: 'management, administrator' }).tags).toEqual([
      'management',
      'administrator',
    ])
    expect(toUser({ name: 'a' }).tags).toEqual([])
  })

  it('reads a vhost with the counts it carries', () => {
    expect(
      toVhost({
        name: '/',
        description: 'Default virtual host',
        messages: 9,
        messages_ready: 8,
        messages_unacknowledged: 1,
      }),
    ).toEqual({
      name: '/',
      description: 'Default virtual host',
      messages: 9,
      ready: 8,
      unacked: 1,
    })
    expect(toVhost({ name: 'x', description: '' }).description).toBeNull()
  })
})

describe('toOverview', () => {
  it('reads the totals, the rates, the nodes and the listeners', () => {
    const overview = toOverview(
      {
        rabbitmq_version: '3.13.7',
        erlang_version: '26.2',
        cluster_name: 'rabbit@a',
        object_totals: { queues: 4, exchanges: 9, connections: 2, channels: 3, consumers: 1 },
        queue_totals: { messages: 10, messages_ready: 8, messages_unacknowledged: 2 },
        message_stats: { publish_details: { rate: 2 } },
        listeners: [{ node: 'rabbit@a', protocol: 'amqp', port: 5672 }],
      },
      { name: 'guest', tags: ['administrator'] },
      [
        { name: 'rabbit@a', running: true, mem_used: 5, fd_used: 3 },
        { name: 'rabbit@b', running: false },
      ],
    )
    expect(overview).toMatchObject({
      version: '3.13.7',
      totals: { queues: 4, messages: 10, ready: 8, unacked: 2 },
      rates: { publish: 2, deliver: 0, ack: 0 },
      user: { name: 'guest' },
      listeners: [{ protocol: 'amqp', port: 5672 }],
    })
    expect(overview.nodes.map((n) => [n.name, n.running])).toEqual([
      ['rabbit@a', true],
      ['rabbit@b', false],
    ])
  })

  it('copes with a broker that sends almost nothing', () => {
    expect(toOverview({}, null, null)).toMatchObject({
      version: 'unknown',
      totals: { queues: 0 },
      nodes: [],
    })
  })
})

describe('message properties', () => {
  it('go to the broker in its spelling and come back in ours', () => {
    const ours = {
      contentType: 'application/json',
      deliveryMode: 2,
      priority: 5,
      messageId: 'm1',
      headers: { a: 1 },
    }
    const theirs = fromProperties(ours)
    expect(theirs).toEqual({
      content_type: 'application/json',
      delivery_mode: 2,
      priority: 5,
      message_id: 'm1',
      headers: { a: 1 },
    })
    expect(toProperties(theirs)).toEqual(ours)
  })

  it('leave out what is not set', () => {
    expect(fromProperties({ contentType: '', headers: {} })).toEqual({})
    expect(toProperties({ headers: {} })).toEqual({})
  })
})

describe('toPeeked', () => {
  it('reads a message and says when its payload was cut', () => {
    const message = toPeeked(
      {
        payload_bytes: 500,
        redelivered: true,
        exchange: 'ex',
        routing_key: 'k',
        message_count: 3,
        payload: 'abc',
        payload_encoding: 'string',
        properties: { content_type: 'text/plain' },
      },
      2,
      100,
    )
    expect(message).toMatchObject({
      index: 2,
      redelivered: true,
      exchange: 'ex',
      routingKey: 'k',
      remaining: 3,
      payload: 'abc',
      payloadBytes: 500,
      truncated: true,
      properties: { contentType: 'text/plain' },
    })
    expect(toPeeked({ payload_bytes: 3, payload: 'abc' }, 1, 100).truncated).toBe(false)
    expect(toPeeked({ payload: 'AQID', payload_encoding: 'base64' }, 1, 100).payloadEncoding).toBe(
      'base64',
    )
  })
})
