export const PAGE_CONTRACTS = {
  uploadRoute: '/newOrder/#/pcb/newOnlinePlaceOrder',
  orderRoute: '/newOrder/#/pcb/pcbPlaceOrder',
  orderListRoute: '/newOrder/#/pcb/pcbOrderList',
  gerberInput: 'input[type="file"][name="file"]',
  orderCard: '.tableListBox',
  orderDetailsDialog: '.pcb-order-details-modal',
  checkOrderButton: '检查订单',
  finalSubmitButton: '确认并提交',
  manualConfirmation: '手动确认订单',
  progressLink: '进度跟踪'
} as const;
