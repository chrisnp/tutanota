// @flow
import * as url from 'url'
import path from 'path'
import {exec, spawn} from 'child_process'
import {promisify} from 'util'
import fs from "fs-extra"
import {app} from 'electron'
import {defer} from '../api/common/utils/Utils.js'
import {DesktopCryptoFacade} from "./DesktopCryptoFacade"
import {neverNull, noOp} from "../api/common/utils/Utils"
import {sanitizeFilename} from "../api/common/utils/FileUtils"
import {Mode} from "../api/Env"

export default class DesktopUtils {

	/**
	 * @param pathToConvert absolute Path to a file
	 * @returns {string} file:// URL that can be extended with query parameters and loaded with BrowserWindow.loadURL()
	 */
	static pathToFileURL(pathToConvert: string): string {
		pathToConvert = pathToConvert
			.trim()
			.split(path.sep)
			.map((fragment) => encodeURIComponent(fragment))
			.join("/")
		const extraSlashForWindows = process.platform === "win32" && pathToConvert !== ''
			? "/"
			: ""
		let urlFromPath = url.format({
			pathname: extraSlashForWindows + pathToConvert.trim(),
			protocol: 'file:'
		})

		return urlFromPath.trim()
	}

	/**
	 * compares a filename to a list of filenames and finds the first number-suffixed
	 * filename not already contained in the list.
	 * @returns {string} the basename appended with '-<first non-clashing positive number>.<ext>
	 */
	static nonClobberingFilename(files: Array<string>, filename: string): string {
		filename = sanitizeFilename(filename)
		const clashingFile = files.find(f => f === filename)
		if (typeof clashingFile !== "string" && !_isReservedFilename(filename)) { // all is well
			return filename
		} else { // there are clashing file names or the file name is reserved
			const ext = path.extname(filename)
			const basename = path.basename(filename, ext)
			const clashNumbers: Array<number> = files
				.filter(f => f.startsWith(`${basename}-`))
				.map(f => f.slice(0, f.length - ext.length))
				.map(f => f.slice(basename.length + 1, f.length))
				.map(f => !f.startsWith('0') ? parseInt(f, 10) : 0)
				.filter(n => !isNaN(n) && n > 0)
			const clashNumbersSet: Set<number> = new Set(clashNumbers)
			clashNumbersSet.add(0)

			// if a number is bigger than its index, there is room somewhere before that number
			const firstGapMinusOne = Array
				.from(clashNumbersSet)
				.sort((a, b) => a - b)
				.find((n, i, a) => a[i + 1] > i + 1)

			return !isNaN(firstGapMinusOne)
				? `${basename}-${neverNull(firstGapMinusOne) + 1}${ext}`
				: `${basename}-${clashNumbersSet.size}${ext}`
		}
	}

	static looksExecutable(file: string): boolean {
		// only windows will happily execute a just downloaded program
		if (process.platform === 'win32') {
			// taken from https://www.lifewire.com/list-of-executable-file-extensions-2626061
			const ext = path.extname(file).toLowerCase().slice(1)
			return [
				'exe', 'bat', 'bin', 'cmd', 'com', 'cpl', 'gadget',
				'inf', 'inx', 'ins', 'isu', 'job', 'jse', 'lnk', 'msc',
				'msi', 'msp', 'mst', 'paf', 'pif', 'ps1', 'reg', 'rgs',
				'scr', 'sct', 'shb', 'sct', 'shs', 'u3p', 'vb', 'vbe',
				'vbs', 'vbscript', 'ws', 'wsf', 'wsh'
			].includes(ext)
		}

		return false
	}

	static checkIsMailtoHandler(): Promise<boolean> {
		return Promise.resolve(app.isDefaultProtocolClient("mailto"))
	}

	/**
	 * open and close a file to make sure it exists
	 * @param path: the file to touch
	 */
	static touch(path: string): void {
		fs.closeSync(fs.openSync(path, 'a'))
	}

	static registerAsMailtoHandler(tryToElevate: boolean): Promise<void> {
		log.debug("trying to register...")
		switch (process.platform) {
			case "win32":
				return checkForAdminStatus()
					.then((isAdmin) => {
						if (!isAdmin && tryToElevate) {
							return _elevateWin(process.execPath, ["-r"])
						} else if (isAdmin) {
							return _registerOnWin()
						}
					})
			case "darwin":
				return app.setAsDefaultProtocolClient("mailto")
					? Promise.resolve()
					: Promise.reject()
			case "linux":
				return app.setAsDefaultProtocolClient("mailto")
					? Promise.resolve()
					: Promise.reject()
			default:
				return Promise.reject(new Error("Invalid process.platform"))
		}
	}

	static unregisterAsMailtoHandler(tryToElevate: boolean): Promise<void> {
		log.debug("trying to unregister...")
		switch (process.platform) {
			case "win32":
				return checkForAdminStatus()
					.then((isAdmin) => {
						if (!isAdmin && tryToElevate) {
							return _elevateWin(process.execPath, ["-u"])
						} else if (isAdmin) {
							return _unregisterOnWin()
						}
					})
			case "darwin":
				return app.removeAsDefaultProtocolClient("mailto")
					? Promise.resolve()
					: Promise.reject()
			case "linux":
				return app.removeAsDefaultProtocolClient("mailto")
					? Promise.resolve()
					: Promise.reject()
			default:
				return Promise.reject(new Error(`invalid platform: ${process.platform}`))
		}
	}

	/**
	 * reads the lockfile and then writes the own version into the lockfile
	 * @returns {Promise<boolean>} whether the lock was overridden by another version
	 */
	static singleInstanceLockOverridden(): Promise<boolean> {
		const lockfilePath = getLockFilePath()
		return fs.readFile(lockfilePath, 'utf8')
		         .then(version => {
			         return fs.writeFile(lockfilePath, app.getVersion(), 'utf8')
			                  .then(() => version !== app.getVersion())
		         })
		         .catch(() => false)
	}

	/**
	 * checks that there's only one instance running while
	 * allowing different versions to steal the single instance lock
	 * from each other.
	 *
	 * should the lock file be unwritable/unreadable, behaves as if all
	 * running instances have the same version, effectively restoring the
	 * default single instance lock behaviour.
	 *
	 * @returns {Promise<boolean>} whether the app was successful in getting the lock
	 */
	static makeSingleInstance(): Promise<boolean> {
		const lockfilePath = getLockFilePath()
		// first, put down a file in temp that contains our version.
		// will overwrite if it already exists.
		// errors are ignored and we fall back to a version agnostic single instance lock.
		return fs.writeFile(lockfilePath, app.getVersion(), 'utf8').catch(noOp)
		         .then(() => {
			         // try to get the lock, if there's already an instance running,
			         // give the other instance time to see if it wants to release the lock.
			         // if it changes the version back, it was a different version and
			         // will terminate itself.
			         return app.requestSingleInstanceLock()
				         ? Promise.resolve(true)
				         : Promise.delay(1500)
				                  .then(() => DesktopUtils.singleInstanceLockOverridden())
				                  .then(canStay => {
					                  if (canStay) {
						                  app.requestSingleInstanceLock()
					                  } else {
						                  app.quit()
					                  }
					                  return canStay
				                  })
		         })
	}

	/**
	 * calls the callback if the ready event was already fired,
	 * registers it as an event listener otherwise
	 * @param callback listener to call
	 */
	static callWhenReady(callback: ()=>void): void {
		if (app.isReady()) {
			callback()
		} else {
			app.once('ready', callback)
		}
	}
}

/**
 * Checks if the user has admin privileges
 * @returns {Promise<boolean>} true if user has admin privileges
 */
function checkForAdminStatus(): Promise<boolean> {
	if (process.platform === 'win32') {
		return promisify(exec)('NET SESSION')
			.then(() => true)
			.catch(() => false)
	} else {
		return Promise.reject(new Error(`No NET SESSION on ${process.platform}`))
	}
}

function getLockFilePath() {
	return path.join(app.getPath('temp'), 'tutanota_desktop_lockfile')
}

/**
 * Writes contents with a random file name into the directory of the executable
 * @param contents
 * @returns {*} path  to the written file
 * @private
 */
function _writeToDisk(contents: string): string {
	const filename = DesktopCryptoFacade.randomHexString(12)
	const filePath = path.join(path.dirname(process.execPath), filename)
	fs.writeFileSync(filePath, contents, {encoding: 'utf-8', mode: 0o400})
	return filePath
}

/**
 * uses the bundled elevate.exe to show a UAC dialog to the user and execute command with elevated permissions
 * @param command
 * @param args
 * @returns {Promise<T>}
 * @private
 */
function _elevateWin(command: string, args: Array<string>) {
	const deferred = defer()
	const elevateExe = path.join((process: any).resourcesPath, "elevate.exe")
	let elevateArgs = ["-wait", command].concat(args)
	spawn(elevateExe, elevateArgs, {
		stdio: ['ignore', 'inherit', 'inherit'],
		detached: false
	}).on('exit', (code, signal) => {
		if (code === 0) {
			deferred.resolve()
		} else {
			deferred.reject(new Error("couldn't elevate permissions"))
		}
	})
	return deferred.promise
}

/**
 * this will silently fail if we're not admin.
 * @param script: path to registry script
 * @private
 */
function _executeRegistryScript(script: string): Promise<void> {
	const deferred = defer()
	const file = _writeToDisk(script)
	spawn('reg.exe', ['import', file], {
		stdio: ['ignore', 'inherit', 'inherit'],
		detached: false
	}).on('exit', (code, signal) => {
		fs.unlinkSync(file)
		if (code === 0) {
			deferred.resolve()
		} else {
			deferred.reject(new Error("couldn't execute registry script"))
		}
	})
	return deferred.promise
}


function _registerOnWin(): Promise<void> {
	const tmpRegScript = require('./reg-templater.js').registerKeys(process.execPath)
	return _executeRegistryScript(tmpRegScript)
		.then(() => {
			app.setAsDefaultProtocolClient('mailto')
		})
}

function _unregisterOnWin(): Promise<void> {
	app.removeAsDefaultProtocolClient('mailto')
	const tmpRegScript = require('./reg-templater.js').unregisterKeys()
	return _executeRegistryScript(tmpRegScript)
}

/**
 * checks if the given filename is a reserved filename on the current platform
 * @param filename
 * @returns {boolean}
 * @private
 */
function _isReservedFilename(filename: string): boolean {
	// CON, CON.txt, COM0 etc. (windows device files)
	const winReservedRe = /^(CON|PRN|LPT[0-9]|COM[0-9]|AUX|NUL)($|\..*$)/i
	// .. and .
	const reservedRe = /^\.{1,2}$/

	return (process.platform === "win32" && winReservedRe.test(filename)) || reservedRe.test(filename)
}

type LogFn = (...args: any) => void
export const log: {debug: LogFn, warn: LogFn, error: LogFn} = (typeof env !== "undefined" && env.mode === Mode.Test)
	? {
		debug: noOp,
		warn: noOp,
		error: noOp,
	}
	: {
		debug: console.log.bind(console),
		warn: console.warn.bind(console),
		error: console.error.bind(console)
	}