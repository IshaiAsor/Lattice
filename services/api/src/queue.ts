import type { Channel } from 'amqplib';
import { connect } from '@lattice/queue';
import { env } from './config/env.config';

let _channel: Channel | undefined;

export async function getChannel(): Promise<Channel> {
  if (!_channel) _channel = await connect(env.rabbitmqUrl);
  return _channel;
}
