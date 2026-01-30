import React from 'react';
import { Plus, MoreVertical, Calendar } from 'lucide-react';
import styles from './Dashboard.module.css';

const Overview = () => {
    const stats = [
        { title: 'Total Revenue', value: '$45,231.89', change: '+20.1%', status: 'up' },
        { title: 'Subscriptions', value: '+2,350', change: '+180.1%', status: 'up' },
        { title: 'Active Now', value: '573', change: '+201', status: 'up' },
        { title: 'Total Users', value: '+12,234', change: '+19.2%', status: 'up' },
    ];

    const transactions = [
        { id: '#12548', user: 'Liam Johnson', date: 'Oct 24, 2023', amount: '$420.00', status: 'Paid' },
        { id: '#12549', user: 'Emma Smith', date: 'Oct 24, 2023', amount: '$120.50', status: 'Pending' },
        { id: '#12550', user: 'Noah Williams', date: 'Oct 23, 2023', amount: '$850.00', status: 'Paid' },
        { id: '#12551', user: 'Olivia Brown', date: 'Oct 23, 2023', amount: '$64.00', status: 'Paid' },
        { id: '#12552', user: 'James Jones', date: 'Oct 22, 2023', amount: '$312.00', status: 'Pending' },
    ];

    return (
        <section className={styles.dashboard}>
            <div className={styles.headerRow}>
                <h1 className={styles.title}>Overview</h1>
                <button className={styles.downloadBtn}>
                    <Plus size={18} />
                    Download Report
                </button>
            </div>

            <div className={styles.statsGrid}>
                {stats.map((stat, i) => (
                    <div key={i} className={styles.statCard}>
                        <div className={styles.statTitle}>{stat.title}</div>
                        <div className={styles.statValue}>
                            {stat.value}
                            <span className={`${styles.statChange} ${styles[stat.status]}`}>
                                {stat.change}
                            </span>
                        </div>
                    </div>
                ))}
            </div>

            <div className={styles.contentGrid}>
                <div className={styles.card}>
                    <div className={styles.cardTitle}>
                        Recent Transactions
                        <MoreVertical size={18} className={styles.cardHeaderIcon} />
                    </div>
                    <table className={styles.dataTable}>
                        <thead>
                            <tr>
                                <th>Invoice ID</th>
                                <th>Customer</th>
                                <th>Date</th>
                                <th>Amount</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {transactions.map((t, i) => (
                                <tr key={i}>
                                    <td>{t.id}</td>
                                    <td>{t.user}</td>
                                    <td>{t.date}</td>
                                    <td>{t.amount}</td>
                                    <td>
                                        <span className={`${styles.statusBadge} ${t.status === 'Paid' ? styles.statusActive : styles.statusPending}`}>
                                            {t.status}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div className={styles.card}>
                    <div className={styles.cardTitle}>
                        Activity Log
                        <Calendar size={18} className={styles.cardHeaderIcon} />
                    </div>
                    <div className={styles.activityList}>
                        {[
                            { time: '2m ago', action: 'New sale recorded', user: 'Premium Plan' },
                            { time: '1h ago', action: 'Support ticket closed', user: 'ID #8821' },
                            { time: '3h ago', action: 'User registered', user: 'Sarah Connor' },
                            { time: '5h ago', action: 'System update', user: 'v2.4.0' },
                        ].map((item, i) => (
                            <div key={i} className={styles.activityItem}>
                                <div className={styles.activityDot}></div>
                                <div className={styles.activityInfo}>
                                    <div>{item.action}</div>
                                    <div>{item.user} • {item.time}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
};

export default Overview;
