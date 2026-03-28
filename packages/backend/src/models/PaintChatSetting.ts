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

	// お題リスト: 汎用（全季節共通）改行区切り
	@Column('text', {
		default: '',
	})
	public topicList: string;

	// お題リスト: 春（3〜5月）改行区切り
	@Column('text', {
		default: '',
	})
	public topicListSpring: string;

	// お題リスト: 夏（6〜8月）改行区切り
	@Column('text', {
		default: '',
	})
	public topicListSummer: string;

	// お題リスト: 秋（9〜11月）改行区切り
	@Column('text', {
		default: '',
	})
	public topicListAutumn: string;

	// お題リスト: 冬（12〜2月）改行区切り
	@Column('text', {
		default: '',
	})
	public topicListWinter: string;

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
