/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';

// admin管理設定。シングルレコード。
@Entity('paint_chat_setting')
export class PaintChatSetting {
	@PrimaryColumn(id())
	public id: string;

	// 投稿用botアカウント
	@Column({
		...id(),
		nullable: true,
	})
	public botAccountId: MiUser['id'] | null;

	@ManyToOne(() => MiUser, {
		onDelete: 'SET NULL',
		nullable: true,
	})
	@JoinColumn({ name: 'botAccountId' })
	public botAccount: MiUser | null;

	// お題リスト（改行区切り）
	@Column('text', {
		default: '',
	})
	public topicList: string;

	// 注意事項テキスト
	@Column('text', {
		default: '',
	})
	public noticeText: string;

	@Column('timestamp with time zone', {
		default: () => 'CURRENT_TIMESTAMP',
	})
	public updatedAt: Date;
}
