import EventEmitter from 'eventemitter3';
//import { get, has } from 'lodash';          // @TODO - make sure that this only imports these functions and dependencies, but not the whole lib
import _ from 'lodash';

/**
 * CrossMessenger
 * @event   receive     When a message or a reply is received
 * @event   message     When a message is received  (NOT a reply)
 * @event   reply       When a reply is received
 * @event   domready    When the DOM is ready
 * @event   handshake   When handshake is successful and ready
 * @event   ready       When both, the dom and the handshake, are successful and ready
 */
class CrossMessenger extends EventEmitter {
    static _idCounter = 0;

    constructor(config) {
        super();

        try {
            this._validateConfig(config);
        } catch(error) {
            console.error(error);
        }

        if (!config.targetFrame) {
            throw new Error('Invalid target frame');
        }

        this._isParentFrame = (config.targetFrame !== window.parent);   // @DEBUG code
        this._loggerFn = this._isParentFrame ? 'info' : 'warn';     // @DEBUG code
        if (this._isParentFrame) {                                  // @DEBUG code
            //CrossMessenger._idCounter = 1000;
        }

        console[this._loggerFn]('constructor ', (this._isParentFrame ? 'PARENT' : 'CHILD'));

        // configureable
        this._targetFrame = (config.targetFrame && 'contentWindow' in config.targetFrame) ? config.targetFrame.contentWindow : config.targetFrame;
        this._targetDomain = config.targetDomain;
        this._messageScope = config.messageScope;
        this._actionRouter = _.get(config, 'actionRouter');

        // protected
        this._waitingForReplyList = {};
        this._hasHandshake = false;
        this._isDomReady = false;

        this._isReady = new Promise((resolve, reject) => {
            this._isReadyResolver = resolve;
            this._isReadyRejector = reject;
        });

        // start listening to incoming messages
        window.addEventListener('message', this._handleReceive);

        // Is dom ready? If so, mark internal ready state as true, otherwise attach
        // an event listener to the document to detect when dom is ready...
        if (document.readyState === 'complete') {
            this._setDomSuccess();
        } else {
            document.addEventListener('DOMContentLoaded', this._setDomSuccess);
        }
    }

    /**
     * Public methods
     */

    /**
     * reply
     * @param replyId
     * @param message
     * @param expectReply
     * @param force
     * @return {*}
     */
    reply(replyId, message, expectReply = false, force = false) {
        return this.send({
                ...message,
                replyId
            },
            expectReply
        );
    }

    /**
     * send
     * Message will only be send when both sides are ready to send and
     * receive messages, or when "force" is true;
     * @param message
     * @param expectReply
     * @param force         boolean     true to send even when system is not ready (internally used for handshake)
     */
    send(message, expectReply = false, force = false) {
        if (force) {
            return this._send(message, expectReply);
        } else {
            return this._isReady.then(() => this._send(message, expectReply));
        }
    }

    /**
     * Protected methods
     */

    _validateConfig(config) {
        const required = ['targetFrame', 'targetDomain', 'messageScope'];

        required.forEach((property) => {
            if (!_.has(config, property)) {
                throw new Error(`Config property: "${property}" is required`);
            };
        });
    }

    /**
     * _send
     * Unsafe send method. Will send message without taking into account if both sides
     * are ready to send and receive messages.
     * @param message
     */
    _send = (message, expectReply = false) => {
        const id = String(CrossMessenger._idCounter++);

        let result,
            serializedMessage;

        if (expectReply) {
            result = new Promise((resolve) => {
                this._waitingForReplyList[id] = resolve;
            });
        } else {
            result = Promise.resolve();
        }

        message.id = id;
        message.messageScope = this._messageScope;
        message.expectReply = expectReply;

        console[this._loggerFn]('Sending ',('replyId' in message ? 'REPLY' : 'MESSAGE'), ' to ', (this._isParentFrame ? 'CHILD' : 'PARENT'), message);

        try {
            serializedMessage = JSON.stringify(message);
            this._targetFrame.postMessage(serializedMessage, this._targetDomain);
        } catch(error) {
            throw new Error('Could not serialize message: ' + error);
        }

        return result;
    }

    _setHandshakeSuccess = () => {
        if (!this._hasHandshake) {
            this._hasHandshake = true;
            this._setReadyWhenReady();
            this.emit('handshake', this);
        }
    }

    _setDomSuccess = () => {
        if (!this._isDomReady) {
            this._isDomReady = true;
            this.emit('domready', this);
            this._setReadyWhenReady();

            if (!this._hasHandshake) {
                this.send({ name: '_handshake' }, false, true);
            }
        }
    }

    _setReadyWhenReady() {
        if (this._hasHandshake && this._isDomReady) {
            console[this._loggerFn]("\n\n\n", 'Set ready ', (this._isParentFrame ? 'PARENT' : 'CHILD'), "\n\n\n\n");
            this._isReadyResolver();
            this.emit('ready', this);
        }
    }

    /**
     * Event handler methods
     */

    _handleReceive = (postMessage) => {
        let message;

         try {
             message = JSON.parse(postMessage.data);
         } catch(error) {
             // Could not parse message. Message is invalid, so ignore...
             return;
         }

        console[this._loggerFn]('Receiving ', ('replyId' in message ? 'REPLY' : 'MESSAGE'),' from  ', (this._isParentFrame ? 'CHILD' : 'PARENT'), message);

        const isValidMessage = (_.get(message, 'messageScope') === this._messageScope && _.has(message, 'id')),
            isHandshake = isValidMessage ? _.get(message, 'name') === '_handshake' : null,
            messageId = isValidMessage ? _.get(message, 'id') : null,
            expectReply = _.get(message, 'expectReply') === true,
            isReply = _.has(message, 'replyId');

        // when the message is not a reply but is a _handshake, confirm
        // the handshake by replying.
        if (isValidMessage && isHandshake && messageId) {
            if (!isReply) {
                this.reply(messageId, {name: '_handshake'}, false, true);
            }

            setTimeout(this._setHandshakeSuccess.bind(this));
        }

        // Not a CrossMessenger message or not a message for this instance...
        if (!isValidMessage) {
            return;
        }

        const name = _.get(message, 'name'),
            isValidReply = _.has(this._waitingForReplyList, _.get(message, 'replyId')),
            replyResolver = isValidReply ? this._waitingForReplyList[message.replyId] : null;

        this.emit('receive', message, this);

        if (isValidReply) {
            replyResolver(message);
            delete this._waitingForReplyList[message.replyId];
            this.emit('reply', message, this);
        } else {
            if (expectReply) {
                const replyPayload = this._actionRouter ? this._actionRouter.handleMessage(message, this) : null;

                this.reply(messageId, {
                    ...message,
                    payload: replyPayload
                });
            } else if(this._actionRouter) {
                this._actionRouter.handleMessage(message, this);
            }

            this.emit('message', message, this);
        }
    }
}

module.exports = CrossMessenger;

// @todo - fix this
window.CrossMessenger = CrossMessenger;