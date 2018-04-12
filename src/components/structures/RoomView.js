/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// TODO: This component is enormous! There's several things which could stand-alone:
//  - Search results component
//  - Drag and drop
//  - File uploading - uploadFile()

import shouldHideEvent from "../../shouldHideEvent";

const React = require("react");
const ReactDOM = require("react-dom");
import PropTypes from 'prop-types';
import Promise from 'bluebird';
const classNames = require("classnames");
import { _t } from '../../languageHandler';

const MatrixClientPeg = require("../../MatrixClientPeg");
const ContentMessages = require("../../ContentMessages");
const Modal = require("../../Modal");
const sdk = require('../../index');
const CallHandler = require('../../CallHandler');
const dis = require("../../dispatcher");
const Tinter = require("../../Tinter");
const rate_limited_func = require('../../ratelimitedfunc');
const ObjectUtils = require('../../ObjectUtils');
const Rooms = require('../../Rooms');

import { KeyCode, isOnlyCtrlOrCmdKeyEvent } from '../../Keyboard';

import RoomViewStore from '../../stores/RoomViewStore';
import RoomScrollStateStore from '../../stores/RoomScrollStateStore';
import SettingsStore from "../../settings/SettingsStore";
import Reply from "../views/elements/ReplyThread";

const DEBUG = false;
let debuglog = function() {};

const BROWSER_SUPPORTS_SANDBOX = 'sandbox' in document.createElement('iframe');

if (DEBUG) {
    // using bind means that we get to keep useful line numbers in the console
    debuglog = console.log.bind(console);
}

module.exports = React.createClass({
    displayName: 'RoomView',
    propTypes: {
        ConferenceHandler: PropTypes.any,

        // Called with the credentials of a registered user (if they were a ROU that
        // transitioned to PWLU)
        onRegistered: PropTypes.func,

        // An object representing a third party invite to join this room
        // Fields:
        // * inviteSignUrl (string) The URL used to join this room from an email invite
        //                          (given as part of the link in the invite email)
        // * invitedEmail (string) The email address that was invited to this room
        thirdPartyInvite: PropTypes.object,

        // Any data about the room that would normally come from the Home Server
        // but has been passed out-of-band, eg. the room name and avatar URL
        // from an email invite (a workaround for the fact that we can't
        // get this information from the HS using an email invite).
        // Fields:
        //  * name (string) The room's name
        //  * avatarUrl (string) The mxc:// avatar URL for the room
        //  * inviterName (string) The display name of the person who
        //  *                      invited us tovthe room
        oobData: PropTypes.object,

        // is the RightPanel collapsed?
        collapsedRhs: PropTypes.bool,
    },

    getInitialState: function() {
        return {
            room: null,
            roomId: null,
            roomLoading: true,
            peekLoading: false,
            shouldPeek: true,

            // The event to be scrolled to initially
            initialEventId: null,
            // The offset in pixels from the event with which to scroll vertically
            initialEventPixelOffset: null,
            // Whether to highlight the event scrolled to
            isInitialEventHighlighted: null,

            forwardingEvent: null,
            editingRoomSettings: false,
            uploadingRoomSettings: false,
            numUnreadMessages: 0,
            draggingFile: false,
            searching: false,
            searchResults: null,
            callState: null,
            guestsCanJoin: false,
            canPeek: false,
            showApps: false,
            isAlone: false,
            isPeeking: false,

            // error object, as from the matrix client/server API
            // If we failed to load information about the room,
            // store the error here.
            roomLoadError: null,

            // Have we sent a request to join the room that we're waiting to complete?
            joining: false,

            // this is true if we are fully scrolled-down, and are looking at
            // the end of the live timeline. It has the effect of hiding the
            // 'scroll to bottom' knob, among a couple of other things.
            atEndOfLiveTimeline: true,

            showTopUnreadMessagesBar: false,

            auxPanelMaxHeight: undefined,

            statusBarVisible: false,
        };
    },

    componentWillMount: function() {
        this.dispatcherRef = dis.register(this.onAction);
        MatrixClientPeg.get().on("Room", this.onRoom);
        MatrixClientPeg.get().on("Room.timeline", this.onRoomTimeline);
        MatrixClientPeg.get().on("Room.name", this.onRoomName);
        MatrixClientPeg.get().on("Room.accountData", this.onRoomAccountData);
        MatrixClientPeg.get().on("RoomState.members", this.onRoomStateMember);
        MatrixClientPeg.get().on("RoomMember.membership", this.onRoomMemberMembership);
        MatrixClientPeg.get().on("accountData", this.onAccountData);

        // Start listening for RoomViewStore updates
        this._roomStoreToken = RoomViewStore.addListener(this._onRoomViewStoreUpdate);
        this._onRoomViewStoreUpdate(true);
    },

    _onRoomViewStoreUpdate: function(initial) {
        if (this.unmounted) {
            return;
        }

        if (!initial && this.state.roomId !== RoomViewStore.getRoomId()) {
            // RoomView explicitly does not support changing what room
            // is being viewed: instead it should just be re-mounted when
            // switching rooms. Therefore, if the room ID changes, we
            // ignore this. We either need to do this or add code to handle
            // saving the scroll position (otherwise we end up saving the
            // scroll position against the wrong room).

            // Given that doing the setState here would cause a bunch of
            // unnecessary work, we just ignore the change since we know
            // that if the current room ID has changed from what we thought
            // it was, it means we're about to be unmounted.
            return;
        }

        const newState = {
            roomId: RoomViewStore.getRoomId(),
            roomAlias: RoomViewStore.getRoomAlias(),
            roomLoading: RoomViewStore.isRoomLoading(),
            roomLoadError: RoomViewStore.getRoomLoadError(),
            joining: RoomViewStore.isJoining(),
            initialEventId: RoomViewStore.getInitialEventId(),
            isInitialEventHighlighted: RoomViewStore.isInitialEventHighlighted(),
            forwardingEvent: RoomViewStore.getForwardingEvent(),
            shouldPeek: RoomViewStore.shouldPeek(),
        };

        // Temporary logging to diagnose https://github.com/vector-im/riot-web/issues/4307
        console.log(
            'RVS update:',
            newState.roomId,
            newState.roomAlias,
            'loading?', newState.roomLoading,
            'joining?', newState.joining,
            'initial?', initial,
            'shouldPeek?', newState.shouldPeek,
        );

        // NB: This does assume that the roomID will not change for the lifetime of
        // the RoomView instance
        if (initial) {
            newState.room = MatrixClientPeg.get().getRoom(newState.roomId);
            if (newState.room) {
                newState.showApps = this._shouldShowApps(newState.room);
                this._onRoomLoaded(newState.room);
            }
        }

        if (this.state.roomId === null && newState.roomId !== null) {
            // Get the scroll state for the new room

            // If an event ID wasn't specified, default to the one saved for this room
            // in the scroll state store. Assume initialEventPixelOffset should be set.
            if (!newState.initialEventId) {
                const roomScrollState = RoomScrollStateStore.getScrollState(newState.roomId);
                if (roomScrollState) {
                    newState.initialEventId = roomScrollState.focussedEvent;
                    newState.initialEventPixelOffset = roomScrollState.pixelOffset;
                }
            }
        }

        // Clear the search results when clicking a search result (which changes the
        // currently scrolled to event, this.state.initialEventId).
        if (this.state.initialEventId !== newState.initialEventId) {
            newState.searchResults = null;
        }

        this.setState(newState);
        // At this point, newState.roomId could be null (e.g. the alias might not
        // have been resolved yet) so anything called here must handle this case.

        // We pass the new state into this function for it to read: it needs to
        // observe the new state but we don't want to put it in the setState
        // callback because this would prevent the setStates from being batched,
        // ie. cause it to render RoomView twice rather than the once that is necessary.
        if (initial) {
            this._setupRoom(newState.room, newState.roomId, newState.joining, newState.shouldPeek);
        }
    },

    _setupRoom: function(room, roomId, joining, shouldPeek) {
        // if this is an unknown room then we're in one of three states:
        // - This is a room we can peek into (search engine) (we can /peek)
        // - This is a room we can publicly join or were invited to. (we can /join)
        // - This is a room we cannot join at all. (no action can help us)
        // We can't try to /join because this may implicitly accept invites (!)
        // We can /peek though. If it fails then we present the join UI. If it
        // succeeds then great, show the preview (but we still may be able to /join!).
        // Note that peeking works by room ID and room ID only, as opposed to joining
        // which must be by alias or invite wherever possible (peeking currently does
        // not work over federation).

        // NB. We peek if we have never seen the room before (i.e. js-sdk does not know
        // about it). We don't peek in the historical case where we were joined but are
        // now not joined because the js-sdk peeking API will clobber our historical room,
        // making it impossible to indicate a newly joined room.
        if (!joining && roomId) {
            if (this.props.autoJoin) {
                this.onJoinButtonClicked();
            } else if (!room && shouldPeek) {
                console.log("Attempting to peek into room %s", roomId);
                this.setState({
                    peekLoading: true,
                    isPeeking: true, // this will change to false if peeking fails
                });
                MatrixClientPeg.get().peekInRoom(roomId).then((room) => {
                    if (this.unmounted) {
                        return;
                    }
                    this.setState({
                        room: room,
                        peekLoading: false,
                    });
                    this._onRoomLoaded(room);
                }, (err) => {
                    if (this.unmounted) {
                        return;
                    }

                    // Stop peeking if anything went wrong
                    this.setState({
                        isPeeking: false,
                    });

                    // This won't necessarily be a MatrixError, but we duck-type
                    // here and say if it's got an 'errcode' key with the right value,
                    // it means we can't peek.
                    if (err.errcode == "M_GUEST_ACCESS_FORBIDDEN") {
                        // This is fine: the room just isn't peekable (we assume).
                        this.setState({
                            peekLoading: false,
                        });
                    } else {
                        throw err;
                    }
                });
            }
        } else if (room) {
            // Stop peeking because we have joined this room previously
            MatrixClientPeg.get().stopPeeking();
            this.setState({isPeeking: false});
        }
    },

    _shouldShowApps: function(room) {
        if (!BROWSER_SUPPORTS_SANDBOX) return false;

        // Check if user has previously chosen to hide the app drawer for this
        // room. If so, do not show apps
        const hideWidgetDrawer = localStorage.getItem(
            room.roomId + "_hide_widget_drawer");

        if (hideWidgetDrawer === "true") {
            return false;
        }

        const appsStateEvents = room.currentState.getStateEvents('im.vector.modular.widgets');
        // any valid widget = show apps
        for (let i = 0; i < appsStateEvents.length; i++) {
            if (appsStateEvents[i].getContent().type && appsStateEvents[i].getContent().url) {
                return true;
            }
        }
        return false;
    },

    componentDidMount: function() {
        const call = this._getCallForRoom();
        const callState = call ? call.call_state : "ended";
        this.setState({
            callState: callState,
        });

        this._updateConfCallNotification();

        window.addEventListener('beforeunload', this.onPageUnload);
        window.addEventListener('resize', this.onResize);
        this.onResize();

        document.addEventListener("keydown", this.onKeyDown);

        // XXX: EVIL HACK to autofocus inviting on empty rooms.
        // We use the setTimeout to avoid racing with focus_composer.
        if (this.state.room &&
            this.state.room.getJoinedMembers().length == 1 &&
            this.state.room.getLiveTimeline() &&
            this.state.room.getLiveTimeline().getEvents() &&
            this.state.room.getLiveTimeline().getEvents().length <= 6) {
            const inviteBox = document.getElementById("mx_SearchableEntityList_query");
            setTimeout(function() {
                if (inviteBox) {
                    inviteBox.focus();
                }
            }, 50);
        }
    },

    shouldComponentUpdate: function(nextProps, nextState) {
        return (!ObjectUtils.shallowEqual(this.props, nextProps) ||
                !ObjectUtils.shallowEqual(this.state, nextState));
    },

    componentDidUpdate: function() {
        if (this.refs.roomView) {
            const roomView = ReactDOM.findDOMNode(this.refs.roomView);
            if (!roomView.ondrop) {
                roomView.addEventListener('drop', this.onDrop);
                roomView.addEventListener('dragover', this.onDragOver);
                roomView.addEventListener('dragleave', this.onDragLeaveOrEnd);
                roomView.addEventListener('dragend', this.onDragLeaveOrEnd);
            }
        }
    },

    componentWillUnmount: function() {
        // set a boolean to say we've been unmounted, which any pending
        // promises can use to throw away their results.
        //
        // (We could use isMounted, but facebook have deprecated that.)
        this.unmounted = true;

        // update the scroll map before we get unmounted
        if (this.state.roomId) {
            RoomScrollStateStore.setScrollState(this.state.roomId, this._getScrollState());
        }

        if (this.refs.roomView) {
            // disconnect the D&D event listeners from the room view. This
            // is really just for hygiene - we're going to be
            // deleted anyway, so it doesn't matter if the event listeners
            // don't get cleaned up.
            const roomView = ReactDOM.findDOMNode(this.refs.roomView);
            roomView.removeEventListener('drop', this.onDrop);
            roomView.removeEventListener('dragover', this.onDragOver);
            roomView.removeEventListener('dragleave', this.onDragLeaveOrEnd);
            roomView.removeEventListener('dragend', this.onDragLeaveOrEnd);
        }
        dis.unregister(this.dispatcherRef);
        if (MatrixClientPeg.get()) {
            MatrixClientPeg.get().removeListener("Room", this.onRoom);
            MatrixClientPeg.get().removeListener("Room.timeline", this.onRoomTimeline);
            MatrixClientPeg.get().removeListener("Room.name", this.onRoomName);
            MatrixClientPeg.get().removeListener("Room.accountData", this.onRoomAccountData);
            MatrixClientPeg.get().removeListener("RoomState.members", this.onRoomStateMember);
            MatrixClientPeg.get().removeListener("RoomMember.membership", this.onRoomMemberMembership);
            MatrixClientPeg.get().removeListener("accountData", this.onAccountData);
        }

        window.removeEventListener('beforeunload', this.onPageUnload);
        window.removeEventListener('resize', this.onResize);

        document.removeEventListener("keydown", this.onKeyDown);

        // Remove RoomStore listener
        if (this._roomStoreToken) {
            this._roomStoreToken.remove();
        }

        // cancel any pending calls to the rate_limited_funcs
        this._updateRoomMembers.cancelPendingCall();

        // no need to do this as Dir & Settings are now overlays. It just burnt CPU.
        // console.log("Tinter.tint from RoomView.unmount");
        // Tinter.tint(); // reset colourscheme
    },

    onPageUnload(event) {
        if (ContentMessages.getCurrentUploads().length > 0) {
            return event.returnValue =
                _t("You seem to be uploading files, are you sure you want to quit?");
        } else if (this._getCallForRoom() && this.state.callState !== 'ended') {
            return event.returnValue =
                _t("You seem to be in a call, are you sure you want to quit?");
        }
    },


    onKeyDown: function(ev) {
        let handled = false;
        const ctrlCmdOnly = isOnlyCtrlOrCmdKeyEvent(ev);

        switch (ev.keyCode) {
            case KeyCode.KEY_D:
                if (ctrlCmdOnly) {
                    this.onMuteAudioClick();
                    handled = true;
                }
                break;

            case KeyCode.KEY_E:
                if (ctrlCmdOnly) {
                    this.onMuteVideoClick();
                    handled = true;
                }
                break;
        }

        if (handled) {
            ev.stopPropagation();
            ev.preventDefault();
        }
    },

    onAction: function(payload) {
        switch (payload.action) {
            case 'message_send_failed':
            case 'message_sent':
                this._checkIfAlone(this.state.room);
                break;
            case 'post_sticker_message':
              this.injectSticker(
                  payload.data.content.url,
                  payload.data.content.info,
                  payload.data.description || payload.data.name);
              break;
            case 'picture_snapshot':
                this.uploadFile(payload.file);
                break;
            case 'notifier_enabled':
            case 'upload_failed':
            case 'upload_started':
            case 'upload_finished':
                this.forceUpdate();
                break;
            case 'call_state':
                // don't filter out payloads for room IDs other than props.room because
                // we may be interested in the conf 1:1 room

                if (!payload.room_id) {
                    return;
                }

                var call = this._getCallForRoom();
                var callState;

                if (call) {
                    callState = call.call_state;
                } else {
                    callState = "ended";
                }

                // possibly remove the conf call notification if we're now in
                // the conf
                this._updateConfCallNotification();

                this.setState({
                    callState: callState,
                });

                break;
            case 'appsDrawer':
                this.setState({
                    showApps: payload.show,
                });
                break;
        }
    },

    onRoomTimeline: function(ev, room, toStartOfTimeline, removed, data) {
        if (this.unmounted) return;

        // ignore events for other rooms
        if (!room) return;
        if (!this.state.room || room.roomId != this.state.room.roomId) return;

        // ignore events from filtered timelines
        if (data.timeline.getTimelineSet() !== room.getUnfilteredTimelineSet()) return;

        if (ev.getType() === "org.matrix.room.preview_urls") {
            this._updatePreviewUrlVisibility(room);
        }

        // ignore anything but real-time updates at the end of the room:
        // updates from pagination will happen when the paginate completes.
        if (toStartOfTimeline || !data || !data.liveEvent) return;

        // no point handling anything while we're waiting for the join to finish:
        // we'll only be showing a spinner.
        if (this.state.joining) return;

        if (ev.getSender() !== MatrixClientPeg.get().credentials.userId) {
            // update unread count when scrolled up
            if (!this.state.searchResults && this.state.atEndOfLiveTimeline) {
                // no change
            } else if (!shouldHideEvent(ev)) {
                this.setState((state, props) => {
                    return {numUnreadMessages: state.numUnreadMessages + 1};
                });
            }
        }
    },

    onRoomName: function(room) {
        if (this.state.room && room.roomId == this.state.room.roomId) {
            this.forceUpdate();
        }
    },

    canResetTimeline: function() {
        if (!this.refs.messagePanel) {
            return true;
        }
        return this.refs.messagePanel.canResetTimeline();
    },

    // called when state.room is first initialised (either at initial load,
    // after a successful peek, or after we join the room).
    _onRoomLoaded: function(room) {
        this._warnAboutEncryption(room);
        this._calculatePeekRules(room);
        this._updatePreviewUrlVisibility(room);
    },

    _warnAboutEncryption: function(room) {
        if (!MatrixClientPeg.get().isRoomEncrypted(room.roomId)) {
            return;
        }
        let userHasUsedEncryption = false;
        if (localStorage) {
            userHasUsedEncryption = localStorage.getItem('mx_user_has_used_encryption');
        }
        if (!userHasUsedEncryption) {
            const QuestionDialog = sdk.getComponent("dialogs.QuestionDialog");
            Modal.createTrackedDialog('E2E Warning', '', QuestionDialog, {
                title: _t("Warning!"),
                hasCancelButton: false,
                description: (
                    <div>
                        <p>{ _t("End-to-end encryption is in beta and may not be reliable") }.</p>
                        <p>{ _t("You should not yet trust it to secure data") }.</p>
                        <p>{ _t("Devices will not yet be able to decrypt history from before they joined the room") }.</p>
                        <p>{ _t("Encrypted messages will not be visible on clients that do not yet implement encryption") }.</p>
                    </div>
                ),
            });
        }
        if (localStorage) {
            localStorage.setItem('mx_user_has_used_encryption', true);
        }
    },

    _calculatePeekRules: function(room) {
        const guestAccessEvent = room.currentState.getStateEvents("m.room.guest_access", "");
        if (guestAccessEvent && guestAccessEvent.getContent().guest_access === "can_join") {
            this.setState({
                guestsCanJoin: true,
            });
        }

        const historyVisibility = room.currentState.getStateEvents("m.room.history_visibility", "");
        if (historyVisibility && historyVisibility.getContent().history_visibility === "world_readable") {
            this.setState({
                canPeek: true,
            });
        }
    },

    _updatePreviewUrlVisibility: function(room) {
        this.setState({
            showUrlPreview: SettingsStore.getValue("urlPreviewsEnabled", room.roomId),
        });
    },

    onRoom: function(room) {
        if (!room || room.roomId !== this.state.roomId) {
            return;
        }
        this.setState({
            room: room,
        }, () => {
            this._onRoomLoaded(room);
        });
    },

    updateTint: function() {
        const room = this.state.room;
        if (!room) return;

        console.log("Tinter.tint from updateTint");
        const color_scheme = SettingsStore.getValue("roomColor", room.roomId);
        Tinter.tint(color_scheme.primary_color, color_scheme.secondary_color);
    },

    onAccountData: function(event) {
        if (event.getType() === "org.matrix.preview_urls" && this.state.room) {
            this._updatePreviewUrlVisibility(this.state.room);
        }
    },

    onRoomAccountData: function(event, room) {
        if (room.roomId == this.state.roomId) {
            if (event.getType() === "org.matrix.room.color_scheme") {
                const color_scheme = event.getContent();
                // XXX: we should validate the event
                console.log("Tinter.tint from onRoomAccountData");
                Tinter.tint(color_scheme.primary_color, color_scheme.secondary_color);
            } else if (event.getType() === "org.matrix.room.preview_urls") {
                this._updatePreviewUrlVisibility(room);
            }
        }
    },

    onRoomStateMember: function(ev, state, member) {
        // ignore if we don't have a room yet
        if (!this.state.room) {
            return;
        }

        // ignore members in other rooms
        if (member.roomId !== this.state.room.roomId) {
            return;
        }

        this._updateRoomMembers();
    },

    onRoomMemberMembership: function(ev, member, oldMembership) {
        if (member.userId == MatrixClientPeg.get().credentials.userId) {
            this.forceUpdate();
        }
    },

    // rate limited because a power level change will emit an event for every
    // member in the room.
    _updateRoomMembers: new rate_limited_func(function() {
        // a member state changed in this room
        // refresh the conf call notification state
        this._updateConfCallNotification();
        this._updateDMState();
    }, 500),

    _checkIfAlone: function(room) {
        let warnedAboutLonelyRoom = false;
        if (localStorage) {
            warnedAboutLonelyRoom = localStorage.getItem('mx_user_alone_warned_' + this.state.room.roomId);
        }
        if (warnedAboutLonelyRoom) {
            if (this.state.isAlone) this.setState({isAlone: false});
            return;
        }

        const joinedMembers = room.currentState.getMembers().filter((m) => m.membership === "join" || m.membership === "invite");
        this.setState({isAlone: joinedMembers.length === 1});
    },

    _updateConfCallNotification: function() {
        const room = this.state.room;
        if (!room || !this.props.ConferenceHandler) {
            return;
        }
        const confMember = room.getMember(
            this.props.ConferenceHandler.getConferenceUserIdForRoom(room.roomId),
        );

        if (!confMember) {
            return;
        }
        const confCall = this.props.ConferenceHandler.getConferenceCallForRoom(confMember.roomId);

        // A conf call notification should be displayed if there is an ongoing
        // conf call but this cilent isn't a part of it.
        this.setState({
            displayConfCallNotification: (
                (!confCall || confCall.call_state === "ended") &&
                confMember.membership === "join"
            ),
        });
    },

    _updateDMState() {
        const me = this.state.room.getMember(MatrixClientPeg.get().credentials.userId);
        if (!me || me.membership !== "join") {
            return;
        }

        // The user may have accepted an invite with is_direct set
        if (me.events.member.getPrevContent().membership === "invite" &&
            me.events.member.getPrevContent().is_direct
        ) {
            // This is a DM with the sender of the invite event (which we assume
            // preceded the join event)
            Rooms.setDMRoom(
                this.state.room.roomId,
                me.events.member.getUnsigned().prev_sender,
            );
            return;
        }

        const invitedMembers = this.state.room.getMembersWithMembership("invite");
        const joinedMembers = this.state.room.getMembersWithMembership("join");

        // There must be one invited member and one joined member
        if (invitedMembers.length !== 1 || joinedMembers.length !== 1) {
            return;
        }

        // The user may have sent an invite with is_direct sent
        const other = invitedMembers[0];
        if (other &&
            other.membership === "invite" &&
            other.events.member.getContent().is_direct
        ) {
            Rooms.setDMRoom(this.state.room.roomId, other.userId);
            return;
        }
    },

    onSearchResultsResize: function() {
        dis.dispatch({ action: 'timeline_resize' }, true);
    },

    onSearchResultsFillRequest: function(backwards) {
        if (!backwards) {
            return Promise.resolve(false);
        }

        if (this.state.searchResults.next_batch) {
            debuglog("requesting more search results");
            const searchPromise = MatrixClientPeg.get().backPaginateRoomEventsSearch(
                this.state.searchResults);
            return this._handleSearchResult(searchPromise);
        } else {
            debuglog("no more search results");
            return Promise.resolve(false);
        }
    },

    onInviteButtonClick: function() {
        // call AddressPickerDialog
        dis.dispatch({
            action: 'view_invite',
            roomId: this.state.room.roomId,
        });
        this.setState({isAlone: false}); // there's a good chance they'll invite someone
    },

    onStopAloneWarningClick: function() {
        if (localStorage) {
            localStorage.setItem('mx_user_alone_warned_' + this.state.room.roomId, true);
        }
        this.setState({isAlone: false});
    },

    onJoinButtonClicked: function(ev) {
        const cli = MatrixClientPeg.get();

        // If the user is a ROU, allow them to transition to a PWLU
        if (cli && cli.isGuest()) {
            // Join this room once the user has registered and logged in
            const signUrl = this.props.thirdPartyInvite ?
                this.props.thirdPartyInvite.inviteSignUrl : undefined;
            dis.dispatch({
                action: 'do_after_sync_prepared',
                deferred_action: {
                    action: 'join_room',
                    opts: { inviteSignUrl: signUrl },
                },
            });

            // Don't peek whilst registering otherwise getPendingEventList complains
            // Do this by indicating our intention to join
            dis.dispatch({
                action: 'will_join',
            });

            const SetMxIdDialog = sdk.getComponent('views.dialogs.SetMxIdDialog');
            const close = Modal.createTrackedDialog('Set MXID', '', SetMxIdDialog, {
                homeserverUrl: cli.getHomeserverUrl(),
                onFinished: (submitted, credentials) => {
                    if (submitted) {
                        this.props.onRegistered(credentials);
                    } else {
                        dis.dispatch({
                            action: 'cancel_after_sync_prepared',
                        });
                        dis.dispatch({
                            action: 'cancel_join',
                        });
                    }
                },
                onDifferentServerClicked: (ev) => {
                    dis.dispatch({action: 'start_registration'});
                    close();
                },
                onLoginClick: (ev) => {
                    dis.dispatch({action: 'start_login'});
                    close();
                },
            }).close;
            return;
        }

        Promise.resolve().then(() => {
            const signUrl = this.props.thirdPartyInvite ?
                this.props.thirdPartyInvite.inviteSignUrl : undefined;
            dis.dispatch({
                action: 'join_room',
                opts: { inviteSignUrl: signUrl },
            });
            return Promise.resolve();
        });
    },

    onMessageListScroll: function(ev) {
        if (this.refs.messagePanel.isAtEndOfLiveTimeline()) {
            this.setState({
                numUnreadMessages: 0,
                atEndOfLiveTimeline: true,
            });
        } else {
            this.setState({
                atEndOfLiveTimeline: false,
            });
        }
        this._updateTopUnreadMessagesBar();
    },

    onDragOver: function(ev) {
        ev.stopPropagation();
        ev.preventDefault();

        ev.dataTransfer.dropEffect = 'none';

        const items = [...ev.dataTransfer.items];
        if (items.length >= 1) {
            const isDraggingFiles = items.every(function(item) {
                return item.kind == 'file';
            });

            if (isDraggingFiles) {
                this.setState({ draggingFile: true });
                ev.dataTransfer.dropEffect = 'copy';
            }
        }
    },

    onDrop: function(ev) {
        ev.stopPropagation();
        ev.preventDefault();
        this.setState({ draggingFile: false });
        const files = [...ev.dataTransfer.files];
        files.forEach(this.uploadFile);
    },

    onDragLeaveOrEnd: function(ev) {
        ev.stopPropagation();
        ev.preventDefault();
        this.setState({ draggingFile: false });
    },

    uploadFile: function(file) {
        if (MatrixClientPeg.get().isGuest()) {
            dis.dispatch({action: 'view_set_mxid'});
            return;
        }

        ContentMessages.sendContentToRoom(
            file, this.state.room.roomId, MatrixClientPeg.get(),
        ).done(() => {
            dis.dispatch({
                action: 'message_sent',
            });
        }, (error) => {
            if (error.name === "UnknownDeviceError") {
                // Let the status bar handle this
                return;
            }
            const ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
            console.error("Failed to upload file " + file + " " + error);
            Modal.createTrackedDialog('Failed to upload file', '', ErrorDialog, {
                title: _t('Failed to upload file'),
                description: ((error && error.message)
                    ? error.message : _t("Server may be unavailable, overloaded, or the file too big")),
            });
        });
    },

    injectSticker: function(url, info, text) {
        if (MatrixClientPeg.get().isGuest()) {
            dis.dispatch({action: 'view_set_mxid'});
            return;
        }

        ContentMessages.sendStickerContentToRoom(url, this.state.room.roomId, info, text, MatrixClientPeg.get())
            .done(undefined, (error) => {
                if (error.name === "UnknownDeviceError") {
                    // Let the staus bar handle this
                    return;
                }
            });
    },

    onSearch: function(term, scope) {
        this.setState({
            searchTerm: term,
            searchScope: scope,
            searchResults: {},
            searchHighlights: [],
        });

        // if we already have a search panel, we need to tell it to forget
        // about its scroll state.
        if (this.refs.searchResultsPanel) {
            this.refs.searchResultsPanel.resetScrollState();
        }

        // make sure that we don't end up showing results from
        // an aborted search by keeping a unique id.
        //
        // todo: should cancel any previous search requests.
        this.searchId = new Date().getTime();

        let filter;
        if (scope === "Room") {
            filter = {
                // XXX: it's unintuitive that the filter for searching doesn't have the same shape as the v2 filter API :(
                rooms: [
                    this.state.room.roomId,
                ],
            };
        }

        debuglog("sending search request");

        const searchPromise = MatrixClientPeg.get().searchRoomEvents({
            filter: filter,
            term: term,
        });
        this._handleSearchResult(searchPromise).done();
    },

    _handleSearchResult: function(searchPromise) {
        const self = this;

        // keep a record of the current search id, so that if the search terms
        // change before we get a response, we can ignore the results.
        const localSearchId = this.searchId;

        this.setState({
            searchInProgress: true,
        });

        return searchPromise.then(function(results) {
            debuglog("search complete");
            if (self.unmounted || !self.state.searching || self.searchId != localSearchId) {
                console.error("Discarding stale search results");
                return;
            }

            // postgres on synapse returns us precise details of the strings
            // which actually got matched for highlighting.
            //
            // In either case, we want to highlight the literal search term
            // whether it was used by the search engine or not.

            let highlights = results.highlights;
            if (highlights.indexOf(self.state.searchTerm) < 0) {
                highlights = highlights.concat(self.state.searchTerm);
            }

            // For overlapping highlights,
            // favour longer (more specific) terms first
            highlights = highlights.sort(function(a, b) {
                return b.length - a.length;
});

            self.setState({
                searchHighlights: highlights,
                searchResults: results,
            });
        }, function(error) {
            const ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
            console.error("Search failed: " + error);
            Modal.createTrackedDialog('Search failed', '', ErrorDialog, {
                title: _t("Search failed"),
                description: ((error && error.message) ? error.message : _t("Server may be unavailable, overloaded, or search timed out :(")),
            });
        }).finally(function() {
            self.setState({
                searchInProgress: false,
            });
        });
    },

    getSearchResultTiles: function() {
        const EventTile = sdk.getComponent('rooms.EventTile');
        const SearchResultTile = sdk.getComponent('rooms.SearchResultTile');
        const Spinner = sdk.getComponent("elements.Spinner");

        const cli = MatrixClientPeg.get();

        // XXX: todo: merge overlapping results somehow?
        // XXX: why doesn't searching on name work?

        if (this.state.searchResults.results === undefined) {
            // awaiting results
            return [];
        }

        const ret = [];

        if (this.state.searchInProgress) {
            ret.push(<li key="search-spinner">
                         <Spinner />
                     </li>);
        }

        if (!this.state.searchResults.next_batch) {
            if (this.state.searchResults.results.length == 0) {
                ret.push(<li key="search-top-marker">
                         <h2 className="mx_RoomView_topMarker">{ _t("No results") }</h2>
                         </li>,
                        );
            } else {
                ret.push(<li key="search-top-marker">
                         <h2 className="mx_RoomView_topMarker">{ _t("No more results") }</h2>
                         </li>,
                        );
            }
        }

        // once dynamic content in the search results load, make the scrollPanel check
        // the scroll offsets.
        const onWidgetLoad = () => {
            const scrollPanel = this.refs.searchResultsPanel;
            if (scrollPanel) {
                scrollPanel.checkScroll();
            }
        };

        let lastRoomId;

        for (let i = this.state.searchResults.results.length - 1; i >= 0; i--) {
            const result = this.state.searchResults.results[i];

            const mxEv = result.context.getEvent();
            const roomId = mxEv.getRoomId();

            if (!EventTile.haveTileForEvent(mxEv)) {
                // XXX: can this ever happen? It will make the result count
                // not match the displayed count.
                continue;
            }

            if (this.state.searchScope === 'All') {
                if (roomId != lastRoomId) {
                    const room = cli.getRoom(roomId);

                    // XXX: if we've left the room, we might not know about
                    // it. We should tell the js sdk to go and find out about
                    // it. But that's not an issue currently, as synapse only
                    // returns results for rooms we're joined to.
                    const roomName = room ? room.name : _t("Unknown room %(roomId)s", { roomId: roomId });

                    ret.push(<li key={mxEv.getId() + "-room"}>
                                 <h1>{ _t("Room") }: { roomName }</h1>
                             </li>);
                    lastRoomId = roomId;
                }
            }

            const resultLink = "#/room/"+roomId+"/"+mxEv.getId();

            ret.push(<SearchResultTile key={mxEv.getId()}
                     searchResult={result}
                     searchHighlights={this.state.searchHighlights}
                     resultLink={resultLink}
                     onWidgetLoad={onWidgetLoad} />);
        }
        return ret;
    },

    onPinnedClick: function() {
        this.setState({showingPinned: !this.state.showingPinned, searching: false});
    },

    onSettingsClick: function() {
        this.showSettings(true);
    },

    onSettingsSaveClick: function() {
        if (!this.refs.room_settings) return;

        this.setState({
            uploadingRoomSettings: true,
        });

        const newName = this.refs.header.getEditedName();
        if (newName !== undefined) {
            this.refs.room_settings.setName(newName);
        }
        const newTopic = this.refs.header.getEditedTopic();
        if (newTopic !== undefined) {
            this.refs.room_settings.setTopic(newTopic);
        }

        this.refs.room_settings.save().then((results) => {
            const fails = results.filter(function(result) { return result.state !== "fulfilled"; });
            console.log("Settings saved with %s errors", fails.length);
            if (fails.length) {
                fails.forEach(function(result) {
                    console.error(result.reason);
                });
                const ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
                Modal.createTrackedDialog('Failed to save room settings', '', ErrorDialog, {
                    title: _t("Failed to save settings"),
                    description: fails.map(function(result) { return result.reason; }).join("\n"),
                });
                // still editing room settings
            } else {
                this.setState({
                    editingRoomSettings: false,
                });
            }
        }).finally(() => {
            this.setState({
                uploadingRoomSettings: false,
                editingRoomSettings: false,
            });
        }).done();
    },

    onCancelClick: function() {
        console.log("updateTint from onCancelClick");
        this.updateTint();
        this.setState({
            editingRoomSettings: false,
        });
        if (this.state.forwardingEvent) {
            dis.dispatch({
                action: 'forward_event',
                event: null,
            });
        }
        dis.dispatch({action: 'focus_composer'});
    },

    onLeaveClick: function() {
        dis.dispatch({
            action: 'leave_room',
            room_id: this.state.room.roomId,
        });
    },

    onForgetClick: function() {
        MatrixClientPeg.get().forget(this.state.room.roomId).done(function() {
            dis.dispatch({ action: 'view_next_room' });
        }, function(err) {
            const errCode = err.errcode || _t("unknown error code");
            const ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
            Modal.createTrackedDialog('Failed to forget room', '', ErrorDialog, {
                title: _t("Error"),
                description: _t("Failed to forget room %(errCode)s", { errCode: errCode }),
            });
        });
    },

    onRejectButtonClicked: function(ev) {
        const self = this;
        this.setState({
            rejecting: true,
        });
        MatrixClientPeg.get().leave(this.state.roomId).done(function() {
            dis.dispatch({ action: 'view_next_room' });
            self.setState({
                rejecting: false,
            });
        }, function(error) {
            console.error("Failed to reject invite: %s", error);

            const msg = error.message ? error.message : JSON.stringify(error);
            const ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
            Modal.createTrackedDialog('Failed to reject invite', '', ErrorDialog, {
                title: _t("Failed to reject invite"),
                description: msg,
            });

            self.setState({
                rejecting: false,
                rejectError: error,
            });
        });
    },

    onRejectThreepidInviteButtonClicked: function(ev) {
        // We can reject 3pid invites in the same way that we accept them,
        // using /leave rather than /join. In the short term though, we
        // just ignore them.
        // https://github.com/vector-im/vector-web/issues/1134
        dis.dispatch({
            action: 'view_room_directory',
        });
    },

    onSearchClick: function() {
        this.setState({ searching: true, showingPinned: false });
    },

    onCancelSearchClick: function() {
        this.setState({
            searching: false,
            searchResults: null,
        });
    },

    // jump down to the bottom of this room, where new events are arriving
    jumpToLiveTimeline: function() {
        this.refs.messagePanel.jumpToLiveTimeline();
        dis.dispatch({action: 'focus_composer'});
    },

    // jump up to wherever our read marker is
    jumpToReadMarker: function() {
        this.refs.messagePanel.jumpToReadMarker();
    },

    // update the read marker to match the read-receipt
    forgetReadMarker: function(ev) {
        ev.stopPropagation();
        this.refs.messagePanel.forgetReadMarker();
    },

    // decide whether or not the top 'unread messages' bar should be shown
    _updateTopUnreadMessagesBar: function() {
        if (!this.refs.messagePanel) {
            return;
        }

        const showBar = this.refs.messagePanel.canJumpToReadMarker();
        if (this.state.showTopUnreadMessagesBar != showBar) {
            this.setState({showTopUnreadMessagesBar: showBar},
                          this.onChildResize);
        }
    },

    // get the current scroll position of the room, so that it can be
    // restored when we switch back to it.
    //
    _getScrollState: function() {
        const messagePanel = this.refs.messagePanel;
        if (!messagePanel) return null;

        // if we're following the live timeline, we want to return null; that
        // means that, if we switch back, we will jump to the read-up-to mark.
        //
        // That should be more intuitive than slavishly preserving the current
        // scroll state, in the case where the room advances in the meantime
        // (particularly in the case that the user reads some stuff on another
        // device).
        //
        if (this.state.atEndOfLiveTimeline) {
            return null;
        }

        const scrollState = messagePanel.getScrollState();

        if (scrollState.stuckAtBottom) {
            // we don't really expect to be in this state, but it will
            // occasionally happen when no scroll state has been set on the
            // messagePanel (ie, we didn't have an initial event (so it's
            // probably a new room), there has been no user-initiated scroll, and
            // no read-receipts have arrived to update the scroll position).
            //
            // Return null, which will cause us to scroll to last unread on
            // reload.
            return null;
        }

        return {
            focussedEvent: scrollState.trackedScrollToken,
            pixelOffset: scrollState.pixelOffset,
        };
    },

    onResize: function(e) {
        // It seems flexbox doesn't give us a way to constrain the auxPanel height to have
        // a minimum of the height of the video element, whilst also capping it from pushing out the page
        // so we have to do it via JS instead.  In this implementation we cap the height by putting
        // a maxHeight on the underlying remote video tag.

        // header + footer + status + give us at least 120px of scrollback at all times.
        let auxPanelMaxHeight = window.innerHeight -
                (83 + // height of RoomHeader
                 36 + // height of the status area
                 72 + // minimum height of the message compmoser
                 (this.state.editingRoomSettings ? (window.innerHeight * 0.3) : 120)); // amount of desired scrollback

        // XXX: this is a bit of a hack and might possibly cause the video to push out the page anyway
        // but it's better than the video going missing entirely
        if (auxPanelMaxHeight < 50) auxPanelMaxHeight = 50;

        this.setState({auxPanelMaxHeight: auxPanelMaxHeight});

        // changing the maxHeight on the auxpanel will trigger a callback go
        // onChildResize, so no need to worry about that here.
    },

    onFullscreenClick: function() {
        dis.dispatch({
            action: 'video_fullscreen',
            fullscreen: true,
        }, true);
    },

    onMuteAudioClick: function() {
        const call = this._getCallForRoom();
        if (!call) {
            return;
        }
        const newState = !call.isMicrophoneMuted();
        call.setMicrophoneMuted(newState);
        this.forceUpdate(); // TODO: just update the voip buttons
    },

    onMuteVideoClick: function() {
        const call = this._getCallForRoom();
        if (!call) {
            return;
        }
        const newState = !call.isLocalVideoMuted();
        call.setLocalVideoMuted(newState);
        this.forceUpdate(); // TODO: just update the voip buttons
    },

    onChildResize: function() {
        // no longer anything to do here
    },

    onStatusBarVisible: function() {
        if (this.unmounted) return;
        this.setState({
            statusBarVisible: true,
        });
    },

    onStatusBarHidden: function() {
        // This is currently not desired as it is annoying if it keeps expanding and collapsing
        // TODO: Find a less annoying way of hiding the status bar
        /*if (this.unmounted) return;
        this.setState({
            statusBarVisible: false,
        });*/
    },

    showSettings: function(show) {
        // XXX: this is a bit naughty; we should be doing this via props
        if (show) {
            this.setState({editingRoomSettings: true});
        }
    },

    /**
     * called by the parent component when PageUp/Down/etc is pressed.
     *
     * We pass it down to the scroll panel.
     */
    handleScrollKey: function(ev) {
        let panel;
        if (this.refs.searchResultsPanel) {
            panel = this.refs.searchResultsPanel;
        } else if (this.refs.messagePanel) {
            panel = this.refs.messagePanel;
        }

        if (panel) {
            panel.handleScrollKey(ev);
        }
    },

    /**
     * get any current call for this room
     */
    _getCallForRoom: function() {
        if (!this.state.room) {
            return null;
        }
        return CallHandler.getCallForRoom(this.state.room.roomId);
    },

    // this has to be a proper method rather than an unnamed function,
    // otherwise react calls it with null on each update.
    _gatherTimelinePanelRef: function(r) {
        this.refs.messagePanel = r;
        if (r) {
            console.log("updateTint from RoomView._gatherTimelinePanelRef");
            this.updateTint();
        }
    },

    render: function() {
        const RoomHeader = sdk.getComponent('rooms.RoomHeader');
        const MessageComposer = sdk.getComponent('rooms.MessageComposer');
        const ForwardMessage = sdk.getComponent("rooms.ForwardMessage");
        const RoomSettings = sdk.getComponent("rooms.RoomSettings");
        const AuxPanel = sdk.getComponent("rooms.AuxPanel");
        const SearchBar = sdk.getComponent("rooms.SearchBar");
        const PinnedEventsPanel = sdk.getComponent("rooms.PinnedEventsPanel");
        const ScrollPanel = sdk.getComponent("structures.ScrollPanel");
        const TintableSvg = sdk.getComponent("elements.TintableSvg");
        const RoomPreviewBar = sdk.getComponent("rooms.RoomPreviewBar");
        const Loader = sdk.getComponent("elements.Spinner");
        const TimelinePanel = sdk.getComponent("structures.TimelinePanel");

        if (!this.state.room) {
            if (this.state.roomLoading || this.state.peekLoading) {
                return (
                    <div className="mx_RoomView">
                        <Loader />
                    </div>
                );
            } else {
                var inviterName = undefined;
                if (this.props.oobData) {
                    inviterName = this.props.oobData.inviterName;
                }
                var invitedEmail = undefined;
                if (this.props.thirdPartyInvite) {
                    invitedEmail = this.props.thirdPartyInvite.invitedEmail;
                }

                // We have no room object for this room, only the ID.
                // We've got to this room by following a link, possibly a third party invite.
                const roomAlias = this.state.roomAlias;
                return (
                    <div className="mx_RoomView">
                        <RoomHeader ref="header"
                            room={this.state.room}
                            oobData={this.props.oobData}
                            collapsedRhs={this.props.collapsedRhs}
                        />
                        <div className="mx_RoomView_auxPanel">
                            <RoomPreviewBar onJoinClick={this.onJoinButtonClicked}
                                            onForgetClick={this.onForgetClick}
                                            onRejectClick={this.onRejectThreepidInviteButtonClicked}
                                            canPreview={false} error={this.state.roomLoadError}
                                            roomAlias={roomAlias}
                                            spinner={this.state.joining}
                                            inviterName={inviterName}
                                            invitedEmail={invitedEmail}
                                            room={this.state.room}
                            />
                        </div>
                        <div className="mx_RoomView_messagePanel"></div>
                    </div>
                );
            }
        }

        const myUserId = MatrixClientPeg.get().credentials.userId;
        const myMember = this.state.room.getMember(myUserId);
        if (myMember && myMember.membership == 'invite') {
            if (this.state.joining || this.state.rejecting) {
                return (
                    <div className="mx_RoomView">
                        <Loader />
                    </div>
                );
            } else {
                const inviteEvent = myMember.events.member;
                var inviterName = inviteEvent.sender ? inviteEvent.sender.name : inviteEvent.getSender();

                // We deliberately don't try to peek into invites, even if we have permission to peek
                // as they could be a spam vector.
                // XXX: in future we could give the option of a 'Preview' button which lets them view anyway.

                // We have a regular invite for this room.
                return (
                    <div className="mx_RoomView">
                        <RoomHeader
                            ref="header"
                            room={this.state.room}
                            collapsedRhs={this.props.collapsedRhs}
                        />
                        <div className="mx_RoomView_auxPanel">
                            <RoomPreviewBar onJoinClick={this.onJoinButtonClicked}
                                            onForgetClick={this.onForgetClick}
                                            onRejectClick={this.onRejectButtonClicked}
                                            inviterName={inviterName}
                                            canPreview={false}
                                            spinner={this.state.joining}
                                            room={this.state.room}
                            />
                        </div>
                        <div className="mx_RoomView_messagePanel"></div>
                    </div>
                );
            }
        }

        // We have successfully loaded this room, and are not previewing.
        // Display the "normal" room view.

        const call = this._getCallForRoom();
        let inCall = false;
        if (call && (this.state.callState !== 'ended' && this.state.callState !== 'ringing')) {
            inCall = true;
        }

        const scrollheader_classes = classNames({
            mx_RoomView_scrollheader: true,
        });

        let statusBar;
        let isStatusAreaExpanded = true;

        if (ContentMessages.getCurrentUploads().length > 0) {
            const UploadBar = sdk.getComponent('structures.UploadBar');
            statusBar = <UploadBar room={this.state.room} />;
        } else if (!this.state.searchResults) {
            const RoomStatusBar = sdk.getComponent('structures.RoomStatusBar');
            isStatusAreaExpanded = this.state.statusBarVisible;
            statusBar = <RoomStatusBar
                room={this.state.room}
                numUnreadMessages={this.state.numUnreadMessages}
                atEndOfLiveTimeline={this.state.atEndOfLiveTimeline}
                sentMessageAndIsAlone={this.state.isAlone}
                hasActiveCall={inCall}
                onInviteClick={this.onInviteButtonClick}
                onStopWarningClick={this.onStopAloneWarningClick}
                onScrollToBottomClick={this.jumpToLiveTimeline}
                onResize={this.onChildResize}
                onVisible={this.onStatusBarVisible}
                onHidden={this.onStatusBarHidden}
                whoIsTypingLimit={3}
            />;
        }

        let aux = null;
        let hideCancel = false;
        if (this.state.editingRoomSettings) {
            aux = <RoomSettings ref="room_settings" onSaveClick={this.onSettingsSaveClick} onCancelClick={this.onCancelClick} room={this.state.room} />;
        } else if (this.state.uploadingRoomSettings) {
            aux = <Loader />;
        } else if (this.state.forwardingEvent !== null) {
            aux = <ForwardMessage onCancelClick={this.onCancelClick} />;
        } else if (this.state.searching) {
            hideCancel = true; // has own cancel
            aux = <SearchBar ref="search_bar" searchInProgress={this.state.searchInProgress} onCancelClick={this.onCancelSearchClick} onSearch={this.onSearch} />;
        } else if (this.state.showingPinned) {
            hideCancel = true; // has own cancel
            aux = <PinnedEventsPanel room={this.state.room} onCancelClick={this.onPinnedClick} />;
        } else if (!myMember || myMember.membership !== "join") {
            // We do have a room object for this room, but we're not currently in it.
            // We may have a 3rd party invite to it.
            var inviterName = undefined;
            if (this.props.oobData) {
                inviterName = this.props.oobData.inviterName;
            }
            var invitedEmail = undefined;
            if (this.props.thirdPartyInvite) {
                invitedEmail = this.props.thirdPartyInvite.invitedEmail;
            }
            hideCancel = true;
            aux = (
                <RoomPreviewBar onJoinClick={this.onJoinButtonClicked}
                                onForgetClick={this.onForgetClick}
                                onRejectClick={this.onRejectThreepidInviteButtonClicked}
                                spinner={this.state.joining}
                                inviterName={inviterName}
                                invitedEmail={invitedEmail}
                                canPreview={this.state.canPeek}
                                room={this.state.room}
                />
            );
        }

        const auxPanel = (
            <AuxPanel ref="auxPanel" room={this.state.room}
              userId={MatrixClientPeg.get().credentials.userId}
              conferenceHandler={this.props.ConferenceHandler}
              draggingFile={this.state.draggingFile}
              displayConfCallNotification={this.state.displayConfCallNotification}
              maxHeight={this.state.auxPanelMaxHeight}
              onResize={this.onChildResize}
              showApps={this.state.showApps}
              hideAppsDrawer={this.state.editingRoomSettings} >
                { aux }
            </AuxPanel>
        );

        let messageComposer, searchInfo;
        const canSpeak = (
            // joined and not showing search results
            myMember && (myMember.membership == 'join') && !this.state.searchResults
        );
        if (canSpeak) {
            messageComposer =
                <MessageComposer
                    room={this.state.room}
                    onResize={this.onChildResize}
                    uploadFile={this.uploadFile}
                    callState={this.state.callState}
                    disabled={this.props.disabled}
                    showApps={this.state.showApps}
                />;
        }

        // TODO: Why aren't we storing the term/scope/count in this format
        // in this.state if this is what RoomHeader desires?
        if (this.state.searchResults) {
            searchInfo = {
                searchTerm: this.state.searchTerm,
                searchScope: this.state.searchScope,
                searchCount: this.state.searchResults.count,
            };
        }

        if (inCall) {
            let zoomButton, voiceMuteButton, videoMuteButton;

            if (call.type === "video") {
                zoomButton = (
                    <div className="mx_RoomView_voipButton" onClick={this.onFullscreenClick} title={_t("Fill screen")}>
                        <TintableSvg src="img/fullscreen.svg" width="29" height="22" style={{ marginTop: 1, marginRight: 4 }} />
                    </div>
                );

                videoMuteButton =
                    <div className="mx_RoomView_voipButton" onClick={this.onMuteVideoClick}>
                        <TintableSvg src={call.isLocalVideoMuted() ? "img/video-unmute.svg" : "img/video-mute.svg"}
                             alt={call.isLocalVideoMuted() ? _t("Click to unmute video") : _t("Click to mute video")}
                             width="31" height="27" />
                    </div>;
            }
            voiceMuteButton =
                <div className="mx_RoomView_voipButton" onClick={this.onMuteAudioClick}>
                    <TintableSvg src={call.isMicrophoneMuted() ? "img/voice-unmute.svg" : "img/voice-mute.svg"}
                         alt={call.isMicrophoneMuted() ? _t("Click to unmute audio") : _t("Click to mute audio")}
                         width="21" height="26" />
                </div>;

            // wrap the existing status bar into a 'callStatusBar' which adds more knobs.
            statusBar =
                <div className="mx_RoomView_callStatusBar">
                    { voiceMuteButton }
                    { videoMuteButton }
                    { zoomButton }
                    { statusBar }
                    <TintableSvg className="mx_RoomView_voipChevron" src="img/voip-chevron.svg" width="22" height="17" />
                </div>;
        }

        // if we have search results, we keep the messagepanel (so that it preserves its
        // scroll state), but hide it.
        let searchResultsPanel;
        let hideMessagePanel = false;

        if (this.state.searchResults) {
            searchResultsPanel = (
                <ScrollPanel ref="searchResultsPanel"
                    className="mx_RoomView_messagePanel mx_RoomView_searchResultsPanel"
                    onFillRequest={this.onSearchResultsFillRequest}
                    onResize={this.onSearchResultsResize}
                >
                    <li className={scrollheader_classes}></li>
                    { this.getSearchResultTiles() }
                </ScrollPanel>
            );
            hideMessagePanel = true;
        }

        const shouldHighlight = this.state.isInitialEventHighlighted;
        let highlightedEventId = null;
        if (this.state.forwardingEvent) {
            highlightedEventId = this.state.forwardingEvent.getId();
        } else if (shouldHighlight) {
            highlightedEventId = this.state.initialEventId;
        }

        // console.log("ShowUrlPreview for %s is %s", this.state.room.roomId, this.state.showUrlPreview);
        const messagePanel = (
            <TimelinePanel ref={this._gatherTimelinePanelRef}
                timelineSet={this.state.room.getUnfilteredTimelineSet()}
                showReadReceipts={!SettingsStore.getValue('hideReadReceipts')}
                manageReadReceipts={!this.state.isPeeking}
                manageReadMarkers={!this.state.isPeeking}
                hidden={hideMessagePanel}
                highlightedEventId={highlightedEventId}
                eventId={this.state.initialEventId}
                eventPixelOffset={this.state.initialEventPixelOffset}
                onScroll={this.onMessageListScroll}
                onReadMarkerUpdated={this._updateTopUnreadMessagesBar}
                showUrlPreview = {this.state.showUrlPreview}
                className="mx_RoomView_messagePanel"
            />);

        let topUnreadMessagesBar = null;
        if (this.state.showTopUnreadMessagesBar) {
            const TopUnreadMessagesBar = sdk.getComponent('rooms.TopUnreadMessagesBar');
            topUnreadMessagesBar = (
                <div className="mx_RoomView_topUnreadMessagesBar">
                    <TopUnreadMessagesBar
                       onScrollUpClick={this.jumpToReadMarker}
                       onCloseClick={this.forgetReadMarker}
                    />
                </div>
            );
        }
        const statusBarAreaClass = classNames(
            "mx_RoomView_statusArea",
            {
                "mx_RoomView_statusArea_expanded": isStatusAreaExpanded,
            },
        );

        const fadableSectionClasses = classNames(
            "mx_RoomView_body", "mx_fadable",
            {
                "mx_fadable_faded": this.props.disabled,
            },
        );

        return (
            <div className={"mx_RoomView" + (inCall ? " mx_RoomView_inCall" : "")} ref="roomView">
                <RoomHeader ref="header" room={this.state.room} searchInfo={searchInfo}
                    oobData={this.props.oobData}
                    editing={this.state.editingRoomSettings}
                    saving={this.state.uploadingRoomSettings}
                    inRoom={myMember && myMember.membership === 'join'}
                    collapsedRhs={this.props.collapsedRhs}
                    onSearchClick={this.onSearchClick}
                    onSettingsClick={this.onSettingsClick}
                    onPinnedClick={this.onPinnedClick}
                    onSaveClick={this.onSettingsSaveClick}
                    onCancelClick={(aux && !hideCancel) ? this.onCancelClick : null}
                    onForgetClick={(myMember && myMember.membership === "leave") ? this.onForgetClick : null}
                    onLeaveClick={(myMember && myMember.membership === "join") ? this.onLeaveClick : null}
                />
                { auxPanel }
                <div className={fadableSectionClasses}>
                    { topUnreadMessagesBar }
                    { messagePanel }
                    { searchResultsPanel }
                    <div className={statusBarAreaClass}>
                        <div className="mx_RoomView_statusAreaBox">
                            <div className="mx_RoomView_statusAreaBox_line"></div>
                            { statusBar }
                        </div>
                    </div>
                    { messageComposer }
                </div>
            </div>
        );
    },
});