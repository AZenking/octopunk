// Port of OctoPunk/OctoPunk/Platform/Notifications/NotificationAdapter.swift.

import { Notification } from "electron";

export class NotificationAdapter {
  async notify(title: string, body: string): Promise<void> {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    notification.show();
  }
}
