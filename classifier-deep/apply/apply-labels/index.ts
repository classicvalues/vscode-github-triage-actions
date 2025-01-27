/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'fs'
import { join } from 'path'
import { context } from '@actions/github'
import { OctoKit, OctoKitIssue } from '../../../api/octokit'
import { getRequiredInput, getInput, safeLog } from '../../../common/utils'
import { Action } from '../../../common/Action'
import { trackEvent } from '../../../common/telemetry'

const token = getRequiredInput('token')
const allowLabels = (getInput('allowLabels') || '').split('|')
const debug = !!getInput('__debug')

type ClassifierConfig = {
	vacation?: string[]
	labels?: {
		[area: string]: { accuracy?: number; assign?: [string] }
	}
	assignees?: {
		[assignee: string]: { accuracy?: number }
	}
}

type Labeling = { confident: boolean; category: string; confidence: number }
type LabelingsFile = { number: number; area: Labeling; assignee: Labeling }[]

class ApplyLabels extends Action {
	id = 'Classifier-Deep/Apply/ApplyLabels'

	async onTriggered(github: OctoKit) {
		const config: ClassifierConfig = await github.readConfig(getRequiredInput('configPath'))
		const labelings: LabelingsFile = JSON.parse(
			readFileSync(join(__dirname, '../issue_labels.json'), { encoding: 'utf8' }),
		)

		for (const labeling of labelings) {
			const issue = new OctoKitIssue(token, context.repo, { number: labeling.number })

			const potentialAssignees: string[] = []
			const addAssignee = async (assignee: string) => {
				if (config.vacation?.includes(assignee)) {
					safeLog('not assigning ', assignee, 'becuase they are on vacation')
				} else {
					potentialAssignees.push(assignee)
				}
			}

			const issueData = await issue.getIssue()

			if (issueData.number !== labeling.number) {
				safeLog(`issue ${labeling.number} moved to ${issueData.number}, skipping`)
				continue
			}

			if (
				!debug &&
				(issueData.assignee || issueData.labels.some((label) => !allowLabels.includes(label)))
			) {
				safeLog('skipping')
				continue
			}

			safeLog(
				'not skipping',
				JSON.stringify({
					assignee: labeling.assignee,
					area: labeling.area,
					number: labeling.number,
				}),
			)

			{
				const { category, confidence, confident } = labeling.area
				if (debug) {
					if (confident) {
						if (!(await github.repoHasLabel(category))) {
							safeLog(`creating label`)
							await github.createLabel(category, 'f1d9ff', '')
						}
						await issue.addLabel(category)
					}
					await issue.postComment(
						`confidence for label ${category}: ${confidence}. ${
							confident ? 'does' : 'does not'
						} meet threshold`,
					)
				}

				if (confident) {
					safeLog(`adding label ${category} to issue ${issueData.number}`)

					const labelConfig = config.labels?.[category]
					await Promise.all<any>([
						...(labelConfig?.assign
							? labelConfig.assign.map((assignee) => addAssignee(assignee))
							: []),
					])

					await trackEvent(issue, 'classification:performed', {
						label: labeling.area.category,
					})
				}
			}

			{
				const { category, confidence, confident } = labeling.assignee
				if (debug) {
					if (confident) {
						if (!(await github.repoHasLabel(category))) {
							safeLog(`creating assignee label`)
							await github.createLabel(category, 'ffa5a1', '')
						}
						await issue.addLabel(category)
					}
					await issue.postComment(
						`confidence for assignee ${category}: ${confidence}. ${
							confident ? 'does' : 'does not'
						} meet threshold`,
					)
				}

				if (confident) {
					safeLog('has assignee')
					await addAssignee(category)
					await trackEvent(issue, 'classification:performed', {
						assignee: labeling.assignee.category,
					})
				}
			}

			if (potentialAssignees.length && !debug) {
				await issue.addAssignee(potentialAssignees[0])
			}
		}
	}
}

new ApplyLabels().run() // eslint-disable-line