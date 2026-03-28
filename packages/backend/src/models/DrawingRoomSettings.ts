/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, Column, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';

@Entity('drawing_room_settings')
export class MiDrawingRoomSettings {
	@PrimaryColumn(id())
	public id: string;

	@Column('integer', {
		default: 1600,
		comment: 'Canvas width in pixels (fixed 1600)',
	})
	public canvasWidth: number;

	@Column('integer', {
		default: 1200,
		comment: 'Canvas height in pixels (fixed 1200)',
	})
	public canvasHeight: number;

	@Column('timestamp with time zone', {
		default: () => 'CURRENT_TIMESTAMP',
	})
	public createdAt: Date;

	@Column('timestamp with time zone', {
		default: () => 'CURRENT_TIMESTAMP',
	})
	public updatedAt: Date;
}
