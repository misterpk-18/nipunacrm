"""Import every model here so relationships between modules resolve.

Models map existing tables (schema lives in db/*.sql); they never create tables.
"""
from models.access import ActiveSession, Role, User, UserRoleScope, UserSession
from models.commercials import (
    ConcessionLimit, Offer, OfferBranch, OfferComplimentaryCourse, OfferCourse, PaymentPlan, PaymentPlanInstallment,
)
from models.courses import ComboCourse, Course, CourseBranch
from models.leads import (
    Enquiry, Lead, LeadActivity, LeadImport, LeadImportRow, LeadQualificationReview, Person, SavedView,
)
from models.masters import (
    LOOKUPS, Branch, BranchShift, ContactChannel, DocumentType, EntryMethod, Holiday, LeadSource, LostReason,
    PaymentMode, SupportCaseType, TaskType,
)
from models.pipeline import PipelineEntry
from models.demos import Demo, DemoReminder
from models.fees import (
    DeliveryPlan, FeeDiscussion, FeeDiscussionVersion, FeeVersionInstallment, SpecialClosingRequest,
)
from models.invoices import (
    Installment, InstallmentDue, Invoice, InvoiceBalance, InvoiceLine, InvoiceLineBalance, PaymentGap,
)
from models.payments import Payment, PaymentAllocation, PaymentCorrectionRequest, UnallocatedAdvance
from models.admissions import Admission, AdmissionBalance, AdmissionFeeChange, AdmissionTransfer
from models.academics import (
    AdmissionCurriculum, Batch, BatchAllocation, BatchAllocationQueue, BatchOccupancy, CurriculumVersion,
)
from models.students import Certificate, Document, DocumentChecklist, SupportCase
from models.refunds import PaymentPromise, RefundCase, RefundCaseReceipt
from models.operations import (
    BranchChannel, Communication, CommunicationInbox, Notification, NotificationRule, Task, TaskBoard,
)
from models.placement import (
    Alumni, ApplicationEvent, Company, JobApplication, JobOpening, PlacementProfile, SupportExtension,
)
from models.management import ReportRun, ScheduledReport, TargetAchievement, TargetVersion, target_lines
from models.system import AppSetting, AuditLog, DeletionRequest, Incident, IntegrationStatus
from models.ai import AiFeedback, AiInsight, AiQuery
from models.lms import LmsOutbox, LmsPullHold, LmsPullState, LmsSyncVersion

__all__ = [
    "LOOKUPS", "ActiveSession", "Admission", "AdmissionBalance", "AdmissionCurriculum", "AdmissionFeeChange",
    "AdmissionTransfer", "AiFeedback", "AiInsight", "AiQuery", "Alumni", "AppSetting", "ApplicationEvent", "AuditLog",
    "Batch", "BatchAllocation", "BatchAllocationQueue", "BatchOccupancy", "Branch", "BranchChannel", "BranchShift",
    "Certificate", "ComboCourse", "Communication", "CommunicationInbox", "Company", "ConcessionLimit",
    "ContactChannel", "Course", "CourseBranch", "CurriculumVersion", "DeletionRequest", "DeliveryPlan", "Demo", "DemoReminder",
    "Document", "DocumentChecklist", "DocumentType", "Enquiry", "EntryMethod", "FeeDiscussion",
    "FeeDiscussionVersion", "FeeVersionInstallment", "Holiday", "Incident", "Installment", "InstallmentDue",
    "IntegrationStatus", "Invoice",
    "InvoiceBalance", "InvoiceLine", "InvoiceLineBalance", "JobApplication", "JobOpening", "Lead", "LeadActivity", "LmsOutbox", "LmsPullHold", "LmsPullState", "LmsSyncVersion", "LeadImport", "LeadImportRow", "LeadQualificationReview",
    "LeadSource", "LostReason", "Notification", "NotificationRule", "Offer", "OfferBranch",
    "OfferComplimentaryCourse", "OfferCourse", "Payment", "PaymentAllocation", "PaymentCorrectionRequest", "PaymentGap", "PaymentMode",
    "PaymentPlan",
    "PaymentPlanInstallment", "PaymentPromise", "Person", "PipelineEntry", "PlacementProfile", "RefundCase",
    "RefundCaseReceipt",
    "ReportRun", "Role", "SavedView", "ScheduledReport", "SpecialClosingRequest", "SupportCase", "SupportCaseType",
    "SupportExtension", "TargetAchievement", "TargetVersion", "Task", "TaskBoard", "TaskType", "UnallocatedAdvance",
    "User", "UserRoleScope", "UserSession", "target_lines",
]
