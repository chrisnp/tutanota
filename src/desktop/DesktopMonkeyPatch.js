// @flow
import chalk from "chalk"
import fs from 'fs-extra'
import path from 'path'
import {app} from 'electron'
import {execSync} from 'child_process'
import {last} from '../api/common/utils/ArrayUtils'
import {neverNull} from "../api/common/utils/Utils"
import {Logger, replaceNativeLogger} from "../api/common/Logger"
import {log} from "./DesktopUtils"

const logger = new Logger()
replaceNativeLogger(global, logger, true)
process.on('exit', () => {
	const logDir = path.join(app.getPath('userData'), 'logs')
	const logFilePath = path.join(logDir, "tutanota_desktop.log")
	const oldLogFilePath = path.join(logDir, "tutanota_desktop_old.log")
	const entries = logger.getEntries()

	fs.mkdirpSync(logDir)

	try {
		fs.renameSync(logFilePath, oldLogFilePath)
	} catch (e) {
		// If the old log was not found, ignore it
		if (e.code !== "ENOENT") {
			console.error("could not rename old log file: ", e.message)
		}
	}
	try {
		fs.writeFileSync(logFilePath, entries.join('\n'))
	} catch (e) {
		console.error("could not write log file: ", e.message)
	}
})

global.env = {rootPathPrefix: "../../", adminTypes: []}
global.System = {'import': (...args) => Promise.resolve(require(...args))}

const oldLog = console.log
const oldError = console.error
const oldWarn = console.warn

;(console: any).log = (...args) => oldLog(chalk.blue(`[${new Date().toISOString()}]`), ...args)
;(console: any).error = (...args) => oldError(chalk.red.bold(`[${new Date().toISOString()}]`), ...args)
;(console: any).warn = (...args) => oldWarn(chalk.yellow(`[${new Date().toISOString()}]`), ...args)

if (process.platform === "win32") {
	try {
		const stdout = execSync('reg query "HKCU\\Control Panel\\Desktop" /v PreferredUILanguages', {encoding: 'utf8'})
		const parts = stdout.split(' ')
		if (parts.length > 0) {
			const locale = neverNull(last(parts)).trim()
			log.debug("detected locale", locale)
			process.env.LC_ALL = locale
		}
	} catch (e) {
		log.debug("failed to detect locale")
	}
}

global.btoa = str => Buffer.from(str, 'binary').toString('base64')
global.atob = b64 => Buffer.from(b64, 'base64').toString('binary')

export function mp() {
	log.debug("the monkey has been patched")
}
